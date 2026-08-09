import { supabase } from '../server/config/supabase.js'

async function run() {
  const { data, error } = await supabase.rpc('get_tables') // if there's get_tables rpc
  if (error) {
    // Let's try direct postgres query via rpc or just check known security/audit tables
    console.error('RPC get_tables failed, let\'s query audit_logs directly:')
    const { data: logs, error: logErr } = await supabase.from('audit_logs').select('*').limit(10)
    if (logErr) {
      console.error('Failed to select from audit_logs:', logErr)
    } else {
      console.log('Sample audit logs:', logs)
    }
  } else {
    console.log('Tables:', data)
  }
}

run()
