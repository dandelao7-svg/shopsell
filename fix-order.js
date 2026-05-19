require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const orderId = parseInt(process.argv[2], 10);
if (!orderId) { console.error('Usage: node fix-order.js <orderId>'); process.exit(1); }

const info = {
  firstName: 'Daniel',
  lastName:  'Delao',
  email:     'dandelao7@gmail.com',
  phone:     '5555550100',
  address1:  '123 Main Street',
  address2:  '',
  city:      'Los Angeles',
  state:     'CA',
  zip:       '90001',
  country:   'US',
};

p.query(
  'UPDATE orders SET customer_info = $1 WHERE id = $2 RETURNING id, customer_info',
  [JSON.stringify(info), orderId]
)
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); p.end(); })
  .catch(e => { console.error(e.message); p.end(); });
