export type Employee = { id: string; name: string; companyId: string; department: string; title: string };
export type Connection = { id: string; companyId: string; employeeId: string; vehicleId: string; connectedAt: string; disconnectedAt: string | null; status: string };
export type Vehicle = { id: string; name: string; plate: string; companyId: string; connection: Connection | null };
export type Qr = { vehicleId: string; status: 'available' | 'connected'; token?: string; url?: string; code?: string; expiresAt?: string; issuedAt?: string; validForMs?: number; connection?: Connection };
export type VehicleRuntime = { vehicleId: string; connectionId: string | null; parking: 'parked' | 'driving' | 'unknown'; sessionActive: boolean; mockOdometerM: number; distanceAvailable: boolean };
export type Purpose = 'business' | 'commute' | 'personal';
export type PurposeDraft = { destination: string | null; purpose: Purpose | null; detailedPurpose: string | null };
export type Conversation = {
  id: string; connectionId: string; vehicleId: string; employeeId: string;
  phase: 'question' | 'awaiting_answer' | 'confirmation' | 'awaiting_confirmation' | 'confirmed' | 'deferred' | 'cancelled' | 'driving' | 'completed';
  draft: PurposeDraft | null; transcript: string; confirmed: boolean; promptId: string | null; isCurrent: boolean;
};
export type Prompt = {
  id: string; conversationId: string; connectionId: string; vehicleId: string; text: string;
  kind: 'question' | 'confirmation'; status: 'pending' | 'claimed' | 'played' | 'failed' | 'simulated' | 'cancelled'; claimedBy: string | null;
};
export type Trip = {
  id: string; tripId: string; connectionId: string; companyId: string; employeeId: string; vehicleId: string; conversationId: string;
  startedAt: string; endedAt: string | null; startOdometerM: number; endOdometerM: number | null; distanceM: number | null;
  destination: string | null; purpose: Purpose | null; detailedPurpose: string | null;
  quality: 'complete' | 'incomplete'; source: 'mock'; purposeConfirmed: boolean;
  lastObservedAt?: string; lastObservedOdometerM?: number; candidateEnd?: { endedAt: string; endOdometerM: number } | null;
  hasGap?: boolean; legInProgress?: boolean;
};
export type PurposeFields = { purpose: Purpose | null; destination: string | null; detailedPurpose: string | null; purposeConfirmed: boolean };
export type Amendment = { requestId: string; tripId: string; version: number; employeeId: string; changedAt: string; before: PurposeFields; after: PurposeFields };
export type ReceivedTrip = Trip & { eventId: string; receivedAt: string; serverVersion: number; amendmentVersion: number; amendmentHistory: Amendment[]; originalPurpose: PurposeFields };
export type PendingUpload = {
  eventId: string; tripId: string; vehicleId: string; body: string;
  status: 'queued' | 'paused' | 'blocked' | 'conflict' | 'received';
  attempts: number; lastError: string | null; nextAttemptAt: number; trip: Trip;
};
export type ServerState = {
  company: { id: string; name: string }; employees: Employee[]; vehicles: Vehicle[]; connections: Connection[]; serverTime: string;
  demoId: string; conversations: Conversation[]; prompts: Prompt[]; activeTrips: Trip[]; pendingUploads: PendingUpload[];
  receivedTrips: ReceivedTrip[]; uploadBlockedVehicles: string[];
  vehicleRuntime: VehicleRuntime[];
};
export type ReportIssue = { code: string; message: string };
export type DummyCost = { id: string; companyId: string; vehicleId: string; occurredOn: string; category: 'fuel' | 'parking' | 'toll'; amountKRW: number; source: 'dummy-fixture'; description: string };
export type MonthlyGroup = { key: string; count: number; validDistanceM: number | null; excludedDistanceCount: number };
export type MonthlyData = {
  month: string; company: { id: string; name: string }; scope: { timeZone: 'Asia/Seoul'; basis: 'startedAt'; allVehicles: true };
  employees: Employee[]; vehicles: Omit<Vehicle, 'connection'>[];
  trips: ReceivedTrip[]; costs: DummyCost[]; pending: { eventId: string; tripId: string; status: string; [key: string]: unknown }[];
  summary: { receivedCount: number; validDistanceM: number | null; excludedDistanceCount: number; unconfirmedCount: number; incompleteCount: number; pendingCount: number; costTotalKRW: number };
  byEmployee: MonthlyGroup[]; byVehicle: MonthlyGroup[]; byPurpose: MonthlyGroup[]; issues: ReportIssue[];
};
export type MonthlyReport = { id: string; companyId: string; month: string; version: number; createdAt: string; fingerprint: string; data: MonthlyData; stale: boolean; readiness: { canSubmit: boolean; reasons: ReportIssue[] } };
export type SubmissionAttempt = { id: string; number: number; requestId: string; requestedAt: string; readyAt: string; completedAt: string | null; outcome: 'success' | 'failure'; receiptNumber: string | null; error: string | null; status: 'processing' | 'completed' | 'failed' };
export type Submission = { id: string; reportId: string; month: string; reportVersion: number; status: 'processing' | 'completed' | 'failed'; attempts: SubmissionAttempt[] };
export type MonthlyResponse = { data: MonthlyData; reports: MonthlyReport[]; submissions: Submission[]; simulationOutcome: 'success' | 'failure' };
