export class UpstreamUnavailableError extends Error {
  constructor(message: string, readonly statusCode: number = 503) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}
