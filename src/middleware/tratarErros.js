import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

export function tratarErros(logger) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const validation = error instanceof ZodError || error.type === 'entity.parse.failed';
    const status = validation ? 400 : error instanceof AppError ? error.status : error.type === 'entity.too.large' ? 413 : 500;
    const code = validation ? 'ENTRADA_INVALIDA' : error instanceof AppError ? error.code : status === 413 ? 'CORPO_EXCESSIVO' : 'ERRO_INTERNO';
    if (status >= 500) logger.error({ requestId: req.id, code }, 'Falha na requisição');
    res.status(status).json({ erro: { codigo: code, mensagem: validation ? 'Parâmetros inválidos.' : error instanceof AppError ? error.message : 'Não foi possível concluir a operação.', requestId: req.id } });
  };
}
