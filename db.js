const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://bd_seguridad_epp_user:8OdHgv8EKafcMPTnNUfWvLnu55SwBFRk@dpg-d8bsno58nd3s738v15i0-a.oregon-postgres.render.com:5432/bd_seguridad_epp',
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = pool;