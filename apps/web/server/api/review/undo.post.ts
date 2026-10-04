import { defineEventHandler } from 'h3';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { handleReviewWorkflowAction } from '../../utils/review-workflow-action';

export default defineEventHandler((event) =>
  handleReviewWorkflowAction(event as ReauthenticationEvent, 'undo'),
);
