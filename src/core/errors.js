export class CodexBridgeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CodexBridgeError';
  }
}

export class NotFoundError extends CodexBridgeError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'NotFoundError';
  }
}

export class ConfigurationError extends CodexBridgeError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}
