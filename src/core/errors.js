export class UserError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export class NotFoundError extends UserError {
  constructor(what = 'Not found') {
    super(what, 404);
    this.name = 'NotFoundError';
  }
}
