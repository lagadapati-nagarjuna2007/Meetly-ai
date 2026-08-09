import { supabase } from '../server/config/supabase.js'

async function run() {
  const { data: users, error } = await supabase
    .from('users')
    .select('*')
  
  if (error) {
    console.error('Error fetching users:', error)
  } else {
    console.log(`Found ${users.length} users:`)
    users.forEach((u, idx) => {
      console.log(`User ${idx + 1}:`)
      console.log(`  id: ${u.id}`)
      console.log(`  full_name: ${u.full_name}`)
      console.log(`  email: ${u.email}`)
    })
  }
}

run()
