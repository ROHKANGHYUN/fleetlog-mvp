export type Purpose = 'business'|'commute'|'personal';
export type Quality = 'valid'|'gap';
export interface TripPayload {vehicleId:string; driverId:string; startedAt:string; endedAt:string; startOdometerM:number; endOdometerM:number; purpose:Purpose|null; note:string; quality:Quality;}
export interface TripEvent {schemaVersion:1; eventType:'TRIP_UPSERT';eventId:string;tripId:string;localRevision:number;expectedServerVersion:number;source:'mock';payload:TripPayload;}
export interface Ack {eventId:string;ackedLocalRevision:number;serverVersion:number;}
export interface StoredTrip {tripId:string;serverVersion:number;localRevision:number;source:'mock';payload:TripPayload;updatedAt:string;}
export const DEMO_VEHICLE_ID:string;
export const DEMO_DRIVER_ID:string;
export const PURPOSES:readonly Purpose[];
export const PURPOSE_LABELS:Readonly<Record<Purpose,string>>;
export function validateTripEvent(value:unknown):TripEvent;
export function canonicalJson(value:unknown):string;
