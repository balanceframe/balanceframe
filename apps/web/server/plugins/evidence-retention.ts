import { getWorkflowStore, type EventWithContext } from '../utils/workflow-store';

/** Apply raw-evidence deadlines without depending on a document being opened. */
export default defineNitroPlugin((app) => {
  const runtimeConfig = useRuntimeConfig();
  const event = { context: { runtimeConfig } } as unknown as EventWithContext;
  const sweep = () => {
    try {
      const workflow = getWorkflowStore(event);
      if ('error' in workflow) throw new Error('Unavailable');
      workflow.store.evidence.expireRaw(new Date().toISOString());
    } catch {
      // Never include source content, paths, or connector exceptions in operational logs.
      console.error('[evidence-retention] raw cleanup unavailable');
    }
  };
  sweep();
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  app.hooks.hook('close', () => clearInterval(timer));
});
