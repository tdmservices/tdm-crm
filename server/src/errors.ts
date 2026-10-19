export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
export const bad = (m: string, extra?: Record<string, unknown>) => new HttpError(400, m, extra);
export const forbidden = (m = "Not allowed") => new HttpError(403, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
export const conflict = (m: string, extra?: Record<string, unknown>) => new HttpError(409, m, extra);
