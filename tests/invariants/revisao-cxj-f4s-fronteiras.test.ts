import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runBeforeSend, pacingGate } from '@/lib/agent-engine/guardrails/before-send';
import { ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS, redriveQueued } from '@/lib/agent-engine/edge/crm/session-reconciler';
import { recordSend, reservarVaga, reservarVagaRelida, loadPacingState } from '@/lib/agent-engine/pacing/store';

// Só PostgreSQL descartável do runner autorizado. O transporte do agente é uma função em RAM.
if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool = new pg.Pool({host:'127.0.0.1',port:Number(process.env.TEST_DB_PORT),user:'postgres',password:'postgres',database:'postgres',max:6});
afterAll(() => pool.end());
// F4r: o resgate é global; abort deixa queued para o próximo tique, não para o próximo teste.
afterEach(async () => { vi.restoreAllMocks(); await pool.query("update messages set status='failed' where status='queued'"); });
const agora = new Date('2026-11-18T14:00:00Z');
const regra = {limite:60,desde:new Date('2026-11-18T03:00:00Z'),vagas:1,intervaloMs:5000};
async function fixture() {
  const org=randomUUID(),contact=randomUUID(),session=randomUUID(),job=randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Teste cxj','Teste cxj','America/Sao_Paulo')",[org]);
  await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato fictício',$3)",[contact,org,'+'+'55'+'88'+'9'.repeat(5)+'1234']);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea,60)",[session,org]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind) values($1,$2,$3,'inbound_turn')",[job,org,contact]);
  await pool.query("insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,warmup_daily_caps) values($1,$2,5000,0,$3::jsonb)",[org,session,JSON.stringify([{minAgeDays:0,cap:null}])]);
  for(let i=0;i<59;i++)await recordSend(pool,org,session,new Date(+agora-3600000+i));
  return {org,contact,session,job};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const sucesso = () => ({kind:'sent' as const,idempotencyKey:'ficticio',messageId:'mensagem-ficticia'});
async function estado(f:Fixture) {return loadPacingState(pool,f.org,f.session,{now:agora,timezone:'America/Sao_Paulo',numberActivatedAt:null})}

function portao(){let abrir!:()=>void;const espera=new Promise<void>(r=>{abrir=r});return {abrir,espera}}
function iniciar(f:Fixture, extras:Partial<Parameters<typeof runBeforeSend>[0]>={}) {
 const log={info:vi.fn(),warn:vi.fn(),error:vi.fn()};
 const send=vi.fn(async()=>sucesso());
 const promessa=runBeforeSend({pool,log,tenantId:f.org,leadId:f.contact,jobId:f.job,channelSessionId:f.session,
 body:'Texto fictício.',optedOutThisTurn:false,crmDailyLimit:null,now:agora,rng:()=>0,sleep:async()=>{},gates:[pacingGate],enforceSpinning:false,send,...extras});
 // O erro é observado imediatamente: nenhuma rejection fica sem tratador.
 const fim=promessa.then(valor=>({valor,erro:null}),erro=>({valor:null,erro}));
 return {fim,send,log};
}


import { sendWithLedger, pgSendLedger } from '@/lib/agent-engine/edge/crm/send-ledger';
const cfg={wahaBaseUrl:'http://cxj.invalid',wahaApiKey:'ficticio',intervalMs:1000,redriveMinAgeMs:0,redriveBatchSize:10,redriveSpacingMs:0};
// O tique seguinte do resgate (S03, S04 e S10): um segundo depois do intervalo do número (5 s) mais a folga da
// vaga, que a reserva do resgate pede desde a versão 15 (F4t do cxj, T03). Na versão 14 eram 6 s, o intervalo e um
// segundo; com a folga, o tique de 6 s não reserva mais, e o que estes casos registram acontece a partir daqui.
// Na versão 16 (F4u do cxj, U02), a linha da vaga anterior também leva a folga (a hora mais tardia do envio): a
// reserva seguinte conta dela, e o tique passa ao intervalo, às duas folgas e a um segundo (10 s). O que os três
// casos registram não muda.
const TIQUE_SEGUINTE=5000+2*ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS+1000;
const log={info:vi.fn(),warn:vi.fn(),error:vi.fn()};
async function enfileirar(f:Fixture) {
 const conversa=randomUUID(),id=randomUUID();
 await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",[conversa,f.org,f.contact,f.session]);
 await pool.query("insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata) values($1,$2,$3,$4,$5,'outbound','text','Fictício','queued','ai',now()-interval '10 minutes','{}')",[id,f.org,conversa,f.contact,f.session]);
 return id;
}
async function ligar(f:Fixture,id:string,kind='inbound_turn',org=f.org,job=f.job,vivo=false) {
 await pool.query('update job_queue set kind=$2, contact_id=$3 where id=$1',[job,kind,['watchdog','flywheel'].includes(kind)?null:f.contact]);
 await pool.query("insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,0,'ficticio','queued',$1)",[id,org,f.contact,job]);
 if(!vivo)await pool.query("update job_queue set status='done' where id=$1",[job]);
}
async function resgatar(f:Fixture,quando=agora,status=200) {
 const transporte=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status}));
 const n=await redriveQueued(pool,cfg,log,undefined,()=>quando);
 return {n,chamadas:transporte.mock.calls.length,estado:await estado(f)};
}
describe('F4s — revisão independente da v13',()=>{
 it.each(['conexão','trava'])('S01 a janela que fecha durante espera de %s impede nova saída',async(modo)=>{
  const f=await fixture();const id=await enfileirar(f);await ligar(f,id);
  await pool.query('update channel_knobs set resposta_start_hour=7,resposta_end_hour=22 where channel_session_id=$1',[f.session]);
  let relogio=new Date('2026-11-19T00:59:59Z');
  const entrou=portao(),soltar=portao();
  const fachada={query:pool.query.bind(pool),connect:async()=>{
   if(modo==='conexão'){entrou.abrir();await soltar.espera;return pool.connect()}
   const c=await pool.connect();const query=c.query.bind(c);
   c.query=(async(...args:unknown[])=>{if(String(args[0]).includes('pg_advisory_xact_lock')){entrou.abrir();await soltar.espera}return Reflect.apply(query,c,args)}) as typeof c.query;
   return c;
  }} as unknown as pg.Pool;
  const transporte=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status:200}));
  const r=redriveQueued(fachada,cfg,log,undefined,()=>relogio);
  try {await entrou.espera;relogio=new Date('2026-11-19T01:00:01Z')}finally{soltar.abrir()}
  await r;
  expect(transporte.mock.calls.length).toBe(0);
 });
 it('S02 lote bloqueado por janela de um número priva resposta elegível de outro',async()=>{
  const a=await fixture(),b=await fixture();const primeira=await enfileirar(a),segunda=await enfileirar(b);await ligar(b,segunda);
  await pool.query("update messages set created_at=now()-interval '20 minutes' where id=$1",[primeira]);
  await pool.query('update channel_knobs set window_start_hour=12,window_end_hour=18 where channel_session_id=$1',[a.session]);
  const transporte=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status:200}));
  for(let i=0;i<3;i++)expect(await redriveQueued(pool,{...cfg,redriveBatchSize:1},log,undefined,()=>new Date(+agora+i*60000))).toBe(0);
  expect(transporte).not.toHaveBeenCalled();
  expect((await pool.query('select status from messages where id=$1',[segunda])).rows[0].status).toBe('queued');
  expect(await redriveQueued(pool,{...cfg,redriveBatchSize:2},log,undefined,()=>agora)).toBe(1);
 });
 // Limite conhecido (F4s do cxj, S03): dois resgates ao mesmo tempo leem a mesma mensagem `queued`
 // e os dois a entregam. A condição de implantação é um vigia só, com o laço serial
 // (`runSessionWatchdogLoop`), e a parada do processo velho antes da subida do novo. `it.fails`
 // guarda a propriedade desejada: se um dia ela passar a valer, o teste acusa, e esta marca sai.
 it.fails('S03 dois resgates concorrentes não devem entregar a mesma mensagem duas vezes',async()=>{
  const f=await fixture();const id=await enfileirar(f);await ligar(f,id);
  const entrou=portao(),soltar=portao();let chamadas=0;
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{chamadas++;if(chamadas===1){entrou.abrir();await soltar.espera}return new Response('{}',{status:200})});
  const a=redriveQueued(pool,cfg,log,undefined,()=>agora);
  try {await entrou.espera;await redriveQueued(pool,cfg,log,undefined,()=>new Date(+agora+TIQUE_SEGUINTE))}finally{soltar.abrir();await a}
  expect(chamadas).toBe(1);
 });
 it('S04 falha no recibo após saída mantém queued e entrega outra vez no próximo tique',async()=>{
  const f=await fixture();const id=await enfileirar(f);await ligar(f,id);
  const query=pool.query.bind(pool);let recusar=true;
  const fachada={query:async(...args:unknown[])=>{if(recusar&&/update messages/.test(String(args[0]))&&/status = 'sent'/.test(String(args[0])))throw new Error('Recibo recusado fictício');return Reflect.apply(query,pool,args)},connect:pool.connect.bind(pool)} as unknown as pg.Pool;
  const transporte=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status:200}));
  await redriveQueued(fachada,cfg,log,undefined,()=>agora);
  expect(transporte).toHaveBeenCalledTimes(1);
  expect((await pool.query('select status from messages where id=$1',[id])).rows[0].status).toBe('queued');
  recusar=false;await redriveQueued(fachada,cfg,log,undefined,()=>new Date(+agora+TIQUE_SEGUINTE));
  expect(transporte).toHaveBeenCalledTimes(2);
 });
 it.each(['motivo','exceção'])('S05 %s na releitura libera trava e não grava débito',async(modo)=>{
  const f=await fixture();
  const reler=async()=>{if(modo==='exceção')throw new Error('releitura recusada');return 'janela_fechada' as const};
  const r=reservarVagaRelida(pool,f.org,f.session,agora,{vagas:1,resposta:true},reler);
  if(modo==='exceção')await expect(r).rejects.toThrow('releitura recusada');else expect(await r).toBe('janela_fechada');
  expect((await estado(f)).sentToday).toBe(59);
  const outra=new pg.Pool({host:'127.0.0.1',port:Number(process.env.TEST_DB_PORT),user:'postgres',password:'postgres',database:'postgres',max:1});
  try {expect(await reservarVaga(outra,f.org,f.session,agora,{...regra,esperaMs:100})).toBe('reservada')}finally{await outra.end()}
 });
 it.each([false,true])('S06 tipo da reserva relida resposta=%s no limite cheio',async(resposta)=>{
  const f=await fixture();await recordSend(pool,f.org,f.session,new Date(+agora-60000));
  const r=await reservarVagaRelida(pool,f.org,f.session,agora,{vagas:1,resposta},async()=>regra);
  expect(r).toBe(resposta?'reservada':'teto_cheio');
  expect((await pool.query('select count(*)::int n from pacing_ledger where organization_id=$1 and resposta',[f.org])).rows[0].n).toBe(resposta?1:0);
 });
 it.each(['pending','running','done','failed','dead'])('S07 dono do job %s',async(status)=>{
  const f=await fixture();const id=await enfileirar(f);await ligar(f,id);
  await pool.query('update job_queue set status=$2 where id=$1',[f.job,status]);
  expect((await resgatar(f)).chamadas).toBe(['pending','running'].includes(status)?0:1);
 });
 it('S08 limite alterado enquanto trava REAL está ocupada é relido',async()=>{
  const f=await fixture();await enfileirar(f);const c=await pool.connect();
  await c.query('begin');await c.query('select pg_advisory_xact_lock(hashtext($1))',[f.session]);
  const entrou=portao();const fachada={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();const query=db.query.bind(db);db.query=(async(...args:unknown[])=>{if(String(args[0]).includes('pg_advisory_xact_lock'))entrou.abrir();return Reflect.apply(query,db,args)}) as typeof db.query;return db}} as unknown as pg.Pool;
  const transporte=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status:200}));
  const r=redriveQueued(fachada,cfg,log,undefined,()=>agora);
  try{await entrou.espera;await pool.query('update channel_sessions set daily_message_limit=59 where id=$1',[f.session])}finally{await c.query('rollback');c.release()}
  await r;expect(transporte).not.toHaveBeenCalled();expect((await estado(f)).sentToday).toBe(59);
 });
 it('S09 pausa durante segunda leitura da parada deve impedir transporte novo',async()=>{
  const f=await fixture();await enfileirar(f);const entrou=portao(),soltar=portao();let leituras=0;
  const query=pool.query.bind(pool);
  const fachada={query:async(...args:unknown[])=>{
   if(String(args[0]).includes('as stopped')&&++leituras===2){entrou.abrir();await soltar.espera}
   return Reflect.apply(query,pool,args);
  },connect:pool.connect.bind(pool)} as unknown as pg.Pool;
  const transporte=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}',{status:200}));
  const tarefa=redriveQueued(fachada,cfg,log,undefined,()=>agora);
  try {await entrou.espera;await pool.query(`update channel_sessions set metadata='{"disabled":true}'::jsonb where id=$1`,[f.session])}finally{soltar.abrir()}
  await tarefa;expect(transporte).not.toHaveBeenCalled();expect((await estado(f)).sentToday).toBe(59);
 });
 it('S10 worker zumbi em voo quando lease expira duplica com resgate',async()=>{
  const {reapExpiredJobs}=await import('@/lib/agent-engine/queue/queue');
  const f=await fixture();const id=await enfileirar(f);await ligar(f,id,'inbound_turn',f.org,f.job,true);
  await pool.query("update job_queue set status='running',locked_by='zumbi-ficticio',locked_at=now()-interval '10 minutes',attempts=max_attempts where id=$1",[f.job]);
  const entrou=portao(),soltar=portao();let saidas=0;
  const tentativa=iniciar(f,{resposta:true,send:async()=>{await sendWithLedger(pgSendLedger(pool),{tenantId:f.org,leadId:f.contact,jobId:f.job,seq:0,body:'Fictício'},async()=>{entrou.abrir();await soltar.espera;saidas++;return {id,status:'sent'}});return sucesso()}});
  try {
   await entrou.espera;expect((await reapExpiredJobs(pool,{visibilityTimeoutMs:1000})).dead).toBe(1);
   vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{saidas++;return new Response('{}',{status:200})});
   expect(await redriveQueued(pool,cfg,log,undefined,()=>new Date(+agora+TIQUE_SEGUINTE))).toBe(1);
  }finally{soltar.abrir();await tentativa.fim}
  expect((await tentativa.fim).erro).toBeNull();expect(saidas).toBe(2);
 });

});
