import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, validateTripEvent } from '../../../packages/contracts/index.mjs';

const IMMUTABLE_PAYLOAD_FIELDS = [
  'vehicleId', 'driverId', 'startedAt', 'endedAt',
  'startOdometerM', 'endOdometerM', 'quality',
];

export class StoreConflict extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreConflict';
    this.code = code;
    this.details = details;
  }
}

function fromRow(row) {
  return {
    tripId: row.trip_id,
    serverVersion: row.server_version,
    localRevision: row.local_revision,
    source: 'mock',
    payload: JSON.parse(row.payload_json),
    updatedAt: row.updated_at,
  };
}

/** Local mock storage only. Every accepted event and its acknowledgement commit together. */
export class TripStore {
  constructor({ filename = ':memory:', now = () => new Date().toISOString() } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS trips (
        trip_id TEXT PRIMARY KEY,
        server_version INTEGER NOT NULL CHECK(server_version >= 1),
        local_revision INTEGER NOT NULL CHECK(local_revision >= 1),
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_receipts (
        event_id TEXT PRIMARY KEY,
        canonical_event TEXT NOT NULL,
        ack_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.findReceipt = this.db.prepare('SELECT canonical_event, ack_json FROM event_receipts WHERE event_id = ?');
    this.findTrip = this.db.prepare('SELECT * FROM trips WHERE trip_id = ?');
    this.writeTrip = this.db.prepare(`
      INSERT INTO trips (trip_id, server_version, local_revision, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trip_id) DO UPDATE SET
        server_version = excluded.server_version,
        local_revision = excluded.local_revision,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    this.writeReceipt = this.db.prepare('INSERT INTO event_receipts (event_id, canonical_event, ack_json, created_at) VALUES (?, ?, ?, ?)');
  }

  upsert(input) {
    const event = validateTripEvent(input);
    const canonical = canonicalJson(event);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.findReceipt.get(event.eventId);
      if (receipt) {
        if (receipt.canonical_event !== canonical) {
          throw new StoreConflict('EVENT_ID_REUSED', '같은 eventId에 다른 본문을 사용할 수 없습니다.');
        }
        const ack = JSON.parse(receipt.ack_json);
        this.db.exec('COMMIT');
        return ack;
      }

      const current = this.findTrip.get(event.tripId);
      const serverVersion = current?.server_version ?? 0;
      if (event.expectedServerVersion !== serverVersion) {
        throw new StoreConflict('SERVER_VERSION_CONFLICT', '서버의 최신 버전을 확인한 뒤 보완해 주세요.', {
          expectedServerVersion: event.expectedServerVersion,
          currentServerVersion: serverVersion,
        });
      }
      if (current && event.localRevision <= current.local_revision) {
        throw new StoreConflict('LOCAL_REVISION_CONFLICT', '새 변경의 localRevision은 저장된 리비전보다 커야 합니다.', {
          currentLocalRevision: current.local_revision,
        });
      }
      if (current) {
        const originalPayload = JSON.parse(current.payload_json);
        const changedFields = IMMUTABLE_PAYLOAD_FIELDS.filter((field) => originalPayload[field] !== event.payload[field]);
        if (changedFields.length > 0) {
          throw new StoreConflict('RAW_FIELDS_IMMUTABLE', '기존 운행의 원본 필드는 수정할 수 없습니다. 목적과 메모만 보완할 수 있습니다.', {
            changedFields,
          });
        }
      }

      const ack = {
        eventId: event.eventId,
        ackedLocalRevision: event.localRevision,
        serverVersion: serverVersion + 1,
      };
      const timestamp = this.now();
      this.writeTrip.run(event.tripId, ack.serverVersion, event.localRevision, canonicalJson(event.payload), timestamp);
      this.writeReceipt.run(event.eventId, canonical, JSON.stringify(ack), timestamp);
      this.db.exec('COMMIT');
      return ack;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list() {
    return this.db.prepare('SELECT * FROM trips ORDER BY updated_at DESC, trip_id ASC').all().map(fromRow);
  }

  exceptions() {
    return this.list().filter((trip) => trip.payload.purpose === null || trip.payload.quality !== 'valid');
  }

  summary() {
    const trips = this.list();
    const unconfirmedCount = trips.filter((trip) => trip.payload.purpose === null).length;
    const invalidDistanceCount = trips.filter((trip) => trip.payload.quality !== 'valid').length;
    return {
      receivedCount: trips.length,
      unconfirmedCount,
      invalidDistanceCount,
      readyForPurposeReview: trips.length > 0 && unconfirmedCount === 0 && invalidDistanceCount === 0,
      notice: '목적 입력과 수신 상태를 보여주는 mock 개발용 요약입니다. 관리자 승인, 기간 거리 대조, 마감 또는 세무신고 완료를 뜻하지 않습니다.',
    };
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
