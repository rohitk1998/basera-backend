const { DataSource } = require('typeorm');
const dataSource = new DataSource({
  type: 'postgres',
  url: 'postgresql://postgres.dkmlkbhwzvexwdgxpexg:RohitK%235234@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
});
async function run() {
  await dataSource.initialize();
  const res = await dataSource.query(`SELECT * FROM payments`);
  console.log('payments:', res);
  const bookings = await dataSource.query(`SELECT * FROM bookings WHERE id = $1`, [res[0].booking_id]);
  console.log('bookings:', bookings);

  process.exit(0);
}
run();
