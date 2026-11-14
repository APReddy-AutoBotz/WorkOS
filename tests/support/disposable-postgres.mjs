import pg from 'pg';

// pg-pool may resolve end() after removing clients from its collection but
// before their sockets finish closing. Track public client-end events from
// creation, including clients removed after an expected SQL validation error.
const closingClients=new WeakMap();
export const createDisposablePool=options=>{
  const pool=new pg.Pool(options),clients=new Set();closingClients.set(pool,clients);
  pool.on('connect',client=>{
    const closed=new Promise(resolve=>client.once('end',resolve));
    clients.add(closed);void closed.then(()=>clients.delete(closed));
  });
  return pool;
};
export const closeDisposablePool=async pool=>{
  const clients=closingClients.get(pool);
  if(!clients)throw new Error('Disposable PostgreSQL pool must be tracked from creation.');
  let timeout;
  const complete=(async()=>{await pool.end();await Promise.all([...clients]);})();
  try{await Promise.race([complete,new Promise((_,reject)=>{
    timeout=setTimeout(()=>reject(new Error('Disposable PostgreSQL clients did not finish closing.')),5000);
  })]);}
  finally{clearTimeout(timeout);}
};
