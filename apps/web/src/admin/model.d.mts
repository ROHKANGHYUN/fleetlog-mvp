import type { Purpose, StoredTrip, TripPayload } from '../../../../packages/contracts/index.mjs';
export interface AdminFilters {
  from:string;to:string;purpose:'all'|Purpose;unconfirmed:'all'|'yes'|'no';distance:'all'|'needs'|'valid';vehicleId:string;driverId:string;query:string;
}
export interface SummaryGroup {
  key:Purpose|'unconfirmed';label:string;count:number;validDistanceM:number|null;validDistanceCount:number;excludedDistanceCount:number;
}
export interface AdminSummary {
  receivedCount:number;needsReviewCount:number;unconfirmedCount:number;invalidDistanceCount:number;validDistanceM:number|null;validDistanceCount:number;excludedDistanceCount:number;groups:SummaryGroup[];
}
export interface AdminSelection {
  allLatest:StoredTrip[];filtered:StoredTrip[];exceptions:StoredTrip[];rows:StoredTrip[];page:number;pages:number;total:number;
  summary:AdminSummary;options:{vehicleIds:string[];driverIds:string[]};filterError:string|null;
}
export function defaultFilters():AdminFilters;
export function distanceMeters(payload:Pick<TripPayload,'quality'|'startOdometerM'|'endOdometerM'>):number|null;
export function exceptionReasons(trip:StoredTrip):string[];
export function formatKst(value:string):string;
export function selectTrips(trips:StoredTrip[],filters?:AdminFilters,options?:{view?:'records'|'exceptions'|'summary';sort?:'newest'|'oldest';page?:number;pageSize?:number}):AdminSelection;
