export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function safeError(error) {
  return error instanceof AppError ? error.message : 'Falha interna. Consulte o identificador da execução nos logs.';
}
