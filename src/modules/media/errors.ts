// Typed errors of the media service. Messages are fixed text (ids and limits at most): file names,
// file content and local paths never go into an error.

export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than the allowed ${maxBytes} bytes`);
    this.name = 'FileTooLargeError';
  }
}

/** The same file (by SHA-256) is already in the client's library. */
export class DuplicateMediaError extends Error {
  constructor(readonly existingId: string) {
    super('This file is already in the media library');
    this.name = 'DuplicateMediaError';
  }
}

export class InvalidMediaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaInputError';
  }
}

/** The media item does not exist for this client (or is deleted where that matters). */
export class MediaNotFoundError extends Error {
  constructor() {
    super('Media not found');
    this.name = 'MediaNotFoundError';
  }
}

/** An authorization id that does not belong to this client. */
export class AutorizacionNotFoundError extends Error {
  constructor() {
    super('Image authorization not found for this client');
    this.name = 'AutorizacionNotFoundError';
  }
}
