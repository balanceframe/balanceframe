import { defineEventHandler } from 'h3';
import { proposeRuleMutation } from '../../utils/rule-proposal';

export default defineEventHandler((event) => proposeRuleMutation(event, 'update_rule'));
