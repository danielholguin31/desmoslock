/* Public config for the website and admin console.

   The publishable key is designed to ship in browsers. It can do nothing on its
   own: quote requests are insert-only, and every other table is behind
   row-level security that checks auth.uid() in the database. */

const CONFIG = {
  supabaseUrl: 'https://xoholqrbhgffivvklpvd.supabase.co',
  supabaseKey: 'sb_publishable_AccnNR1GRBajugI-Qu0cuQ_RC9V-KDi',
  salesEmail: 'sales@desmoslock.com',
  downloadBase: '/download'
}
