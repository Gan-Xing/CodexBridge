export class CodexBridgeError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'CodexBridgeError';
  }
}

export class NotFoundError extends CodexBridgeError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'NotFoundError';
  }
}

export class ConfigurationError extends CodexBridgeError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

