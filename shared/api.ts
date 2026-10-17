/**
 * The envelope every `/api` response uses. `success` tells the two shapes apart,
 * so an error can never be read as data.
 */
export type ApiResponse<Data> = ApiSuccess<Data> | ApiFailure;

export interface ApiSuccess<Data> {
  readonly success: true;
  readonly data: Data;
}

export interface ApiFailure {
  readonly success: false;
  readonly error: string;
}

export interface HealthData {
  readonly status: "ok";
}

export const HEALTH_PATH = "/api/health";
