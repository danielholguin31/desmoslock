/* Build-time configuration.

   The publishable key is meant to ship inside clients — it grants nothing on its
   own. Every privileged action is gated by row-level security and the
   security-definer RPCs in supabase/schema.sql, which check auth.uid() in the
   database. There is no secret key in this app, and there must never be one:
   anything with a service-role key can read every classroom's data. */

const CONFIG = {
  cloud: {
    url: 'https://xoholqrbhgffivvklpvd.supabase.co',
    publishableKey: 'sb_publishable_AccnNR1GRBajugI-Qu0cuQ_RC9V-KDi'
  },
  // 'cloud' talks to Supabase; 'local' talks to a DesmosLock server on the LAN.
  defaultMode: 'cloud',
  defaultServer: 'http://localhost:4000'
}
