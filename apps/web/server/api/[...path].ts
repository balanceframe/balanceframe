import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { errorEnvelope } from '../utils/workflow-store';

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  setResponseStatus(event, 404);
  return errorEnvelope('NOT_FOUND', 'API route not found.', null);
});
