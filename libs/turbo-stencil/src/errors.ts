/**
 * User-facing failure: config mistakes, unreadable files, refused operations.
 * The CLI prints these without a stack trace.
 */
export class StencilError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StencilError';
  }
}
