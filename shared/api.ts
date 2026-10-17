/**
 * The envelope every `/api` response uses. `success` tells the two shapes apart,
 * so an error can never be read as data.
 */
export type ApiResponse<Data> = ApiSuccess<Data> | ApiFailure;

export interface ApiSuccess<Data> {
  readonly success: true;
  readonly data: Data;
}

export type ApiErrorCode = "badRequest" | "forbidden" | "notFound" | "tooLarge" | "internal";

export interface ApiFailure {
  readonly success: false;
  readonly error: string;
  readonly code?: ApiErrorCode;
  /** Every validation problem, not only the first. */
  readonly issues?: readonly string[];
}

export interface HealthData {
  readonly status: "ok";
}

export const HEALTH_PATH = "/api/health";
