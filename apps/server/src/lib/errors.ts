/** An error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) => new AppError(400, code, message, details)
export const unauthorized = (message = 'Sign in to continue', code = 'unauthorized') => new AppError(401, code, message)
export const forbidden = (message = 'You do not have permission to do that', code = 'forbidden') => new AppError(403, code, message)
export const notFound = (message = 'Not found', code = 'not_found') => new AppError(404, code, message)
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message)
