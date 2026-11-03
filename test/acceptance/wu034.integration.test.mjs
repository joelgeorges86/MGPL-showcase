// Author-owned fake-client CLI tests. No real SDK, credentials, catalogue or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MGPL_WU034_ROOT || path.resolve(here,'../..');
globalThis.fetch = () => { throw new Error('Network forbidden in WU-034 integration tests'); };
const load = p => import(pathToFileURL(path.join(root,p)).href);
const en = await load('scripts/catalogue/enrich-gemini.mjs');
const em = await load('scripts/catalogue/embed-descriptions.mjs');
const guard = await load('scripts/probes/act08/lib.mjs');
const sample = await load('scripts/catalogue/sample-check.mjs');
const sha = s => createHash('sha256').update(s).digest('hex');
const NOW = Date.parse('2026-10-20T12:00:00Z');
const text = 'Navigate a small sailing vessel between scattered islands, trade supplies with friendly ports, and restore coastal beacons while exploring a changing sea.';
const sourceText = 'This invented game features sailing, trading between ports, and restoring beacons.';
const jsonl = records => records.map(r=>JSON.stringify(r)).join('\n')+'\n';
const readLines = file => !existsSync(file) ? [] : readFileSync(file,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));

async function fixture(fn,{label='JDG',requestCap=30}={}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(),'mgpl-wu034-cli-'));
  const tempRoot = path.resolve(os.tmpdir())+path.sep;
  assert.ok(path.resolve(tmp).startsWith(tempRoot));
  try {
    const cat = path.join(tmp,'catalogue'); const out = path.join(tmp,'output'); const records = path.join(tmp,'records');
    for (const p of [cat,out,records]) mkdirSync(p);
    const games = [{qid:'Q1',reviews:10},{qid:'Q2',reviews:100},{qid:'Q3',reviews:50}];
    writeFileSync(path.join(cat,'agreement.jsonl'),jsonl(games.map((g,i)=>({qid:g.qid,steam_appid:String(i+101),
      fields:{title:{status:'agree',value:`Synthetic Harbor ${i+1}`}},context:{genres_wikidata:{values:[]}}}))));
    writeFileSync(path.join(cat,'steam.jsonl'),jsonl(games.map((g,i)=>({appid:String(i+101),success:true,type:'game',reviews:{review_count:i+1}}))));
    writeFileSync(path.join(cat,'wikidata.jsonl'),jsonl(games.map((g,i)=>({qid:g.qid,label:`Synthetic Harbor ${i+1}`}))));
    const input = path.join(tmp,'check-input.jsonl');
    writeFileSync(input,jsonl(games.map((g,i)=>({schema:'mgpl-description-check-input/2',qid:g.qid,description:text,
      description_sha256:sha(text),promoted_at:'2026-10-16T12:00:00Z',sample_summary_sha256:sha('synthetic summary'),
      source:{url:`https://en.wikipedia.org/w/index.php?title=Synthetic_Source&oldid=${1001+i}`},review_count:g.reviews}))));
    writeFileSync(path.join(records,'credit-position-synthetic.json'),JSON.stringify({read_at:new Date(NOW-3600000).toISOString(),balance_usd:298}));
    const agentsFile=path.join(tmp,'AGENTS.md');
    const agentLines=readFileSync(path.join(root,'AGENTS.md'),'utf8').split('\n');
    const at=agentLines.findIndex(l=>l.startsWith('| #117 (P-9)'));
    assert.ok(at>=0);
    const embeddingEntry=label.startsWith('EMB');
    agentLines.splice(at+1,0,`| #990 (${label}) | \`scripts/catalogue/${embeddingEntry?'embed-descriptions':'enrich-gemini'}.mjs\`: synthetic test work | \`${embeddingEntry?'us-central1-aiplatform.googleapis.com':'aiplatform.googleapis.com'}\`, location \`${embeddingEntry?'us-central1':'global'}\`, \`${embeddingEntry?'predict':'generateContent'}\` only | Principal Operator | ${requestCap} | $110 | \`${out}\` | 2026-10-16 | 2026-11-06 |`);
    writeFileSync(agentsFile,agentLines.join('\n'));
    const seen=[]; let verdict='contradicts'; let clients=0; let replyReason='Synthetic evidence conflicts with the draft.'; let sourceSuffix='';
    const deps={dir:records,agentsPath:agentsFile,root,now:()=>NOW,sleep:async()=>{},
      log:()=>{},interrupts:new EventEmitter(),
      wikiFetch:async url=>{const u=new URL(url);assert.equal(u.hostname,'en.wikipedia.org');const id=Number(u.searchParams.get('revids'));assert.ok(Number.isSafeInteger(id));return new Response(JSON.stringify({query:{pages:[{title:'Synthetic Source',revisions:[{revid:id,slots:{main:{contentmodel:'wikitext',content:sourceText+(id>=2000?sourceSuffix:'')}}}]}]}}),{status:200,headers:{'content-type':'application/json'}});},

      baseFetch:async(_url,init)=>{
        const body=JSON.parse(String(init.body));
        if (body.instances) {
          seen.push({body,ids:[]});
          return new Response(JSON.stringify({predictions:body.instances.map(instance=>({embeddings:{values:Array.from({length:768},(_,i)=>i===0?parseInt(sha(instance.content).slice(0,6),16)/16777216:0),statistics:{truncated:false,token_count:3}}})),
            metadata:{billableCharacterCount:body.instances.reduce((n,i)=>n+i.content.length,0)}}),{status:200,headers:{'content-type':'application/json'}});
        }
        const prompt=body.contents?.[0]?.parts?.[0]?.text || '';
        const requested=prompt.includes('Games:\n') ? JSON.parse(prompt.slice(prompt.indexOf('Games:\n')+7)) : [];
        seen.push({body,ids:requested.map(g=>g.id)});
        assert.equal(body.tools,undefined,'first-release checking must remain ungrounded');
        const result={candidates:[{content:{role:'model',parts:[{text:JSON.stringify({games:requested.map(g=>
          ({id:g.id,verdict,reason:replyReason,confidence:.8}))})}]}}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:40}};
        return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
      },
      makeClient:holder=>(clients++,{models:{embedContent:async params=>{
        const response=await holder.fetch(guard.expectedEndpoint(params.model,'predict','us-central1'),
          {method:'POST',body:em.predictBody(params.contents),headers:{'content-type':'application/json'}});
        if (!response.ok) throw Object.assign(new Error('Synthetic HTTP failure'),{status:response.status});
        const value=await response.json();
        return {embeddings:value.predictions.map(p=>p.embeddings),metadata:value.metadata};
      },generateContent:async params=>{
        const response=await holder.fetch(guard.expectedEndpoint(params.model,'generateContent','global'),
          {method:'POST',body:en.vertexBody(params),headers:{'content-type':'application/json'}});
        if (!response.ok) throw Object.assign(new Error('Synthetic HTTP failure'),{status:response.status});
        const value=await response.json();
        return {...value,text:value.candidates?.[0]?.content?.parts?.[0]?.text};
      }}}),
    };
    const args=['--run','--entry','#990','--context','none','--out',out,'--reserve','3','--batch','1','--parallel','1'];
    await fn({tmp,cat,out,records,input,deps,args,seen,setVerdict:v=>{verdict=v;},setReason:v=>{replyReason=v;},setSourceSuffix:v=>{sourceSuffix=v;},
      outputs:()=>readdirSync(out).filter(f=>f.endsWith('.jsonl')).flatMap(f=>readLines(path.join(out,f))),
      ledger:()=>readLines(path.join(records,'spend-ledger.jsonl')),clientCount:()=>clients});
  } finally { rmSync(tmp,{recursive:true,force:true}); }
}

test('CLI-JDG-01: request cap checks a popularity prefix and never modifies drafts',async()=>{
  await fixture(async f=>{
    const before=readFileSync(f.input);
    const code=await en.main([...f.args,'--task','check','--check-input',f.input],f.deps);
    assert.equal(code,0);
    assert.deepEqual(f.seen.flatMap(x=>x.ids),['Q2','Q3']);
    assert.deepEqual(readFileSync(f.input),before);
    const records=f.outputs().filter(r=>r.task==='check');
    assert.equal(records.length,2);
    assert.ok(records.every(r=>r.generated?.verdict==='contradicts' && !Object.hasOwn(r.generated,'description')));
    assert.equal(f.ledger().filter(l=>l.type==='attempt').length,2);
  },{requestCap:2});
});
test('CLI-JDG-02: unknown verdict never becomes an ok check record',async()=>{
  await fixture(async f=>{
    f.setVerdict('approved');
    await en.main([...f.args,'--task','check','--check-input',f.input,'--limit','1'],f.deps);
    assert.equal(f.seen.length,1);
    assert.ok(f.outputs().filter(r=>r.task==='check').every(r=>r.status!=='ok'));
  });
});
test('CLI-JDG-03: bad description digest refuses before client, reservation or network',async()=>{
  await fixture(async f=>{
    const records=readLines(f.input); records[0].description+=' altered';
    writeFileSync(f.input,jsonl(records));
    await assert.rejects(en.main([...f.args,'--task','check','--check-input',f.input],f.deps),e=>e.code==='WU034_CHECK_DIGEST');
    assert.equal(f.seen.length,0); assert.equal(f.ledger().length,0);
  });
});
test('CLI-EMB-01: title dry-run works with factual titles and no description or sample files',async()=>{
  await fixture(async f=>{
    // This fixture contains factual titles and no description draft file.
    const code=await em.main(['--text','title','--catalogue',f.cat,'--out',f.out],{...f.deps,catalogue:f.cat});
    assert.equal(code,0); assert.equal(f.seen.length,0); assert.equal(f.ledger().length,0);
  },{label:'EMB-2'});
});
test('CLI-EMB-02: title run embeds factual titles without a sample and resumes by text kind',async()=>{
  await fixture(async f=>{
    const args=['--run','--entry','#990','--text','title','--catalogue',f.cat,'--out',f.out,'--reserve','1','--batch','100'];
    const code=await em.main(args,{...f.deps,catalogue:f.cat});
    assert.equal(code,0);
    assert.equal(f.seen.length,1);
    assert.equal(f.seen[0].body.instances.length,3);
    assert.ok(f.seen[0].body.instances.every(i=>i.content.startsWith('Synthetic Harbor')));
    const file=path.join(f.out,'embed-descriptions-title-text-embedding-005-768.jsonl');
    assert.equal(readLines(file).length,3);
    const before=readFileSync(file);
    await assert.rejects(em.main(args,{...f.deps,catalogue:f.cat}),e=>e.code==='WU034_NOTHING_TO_DO');
    assert.deepEqual(readFileSync(file),before);
    assert.equal(f.seen.length,1);
  },{label:'EMB-2'});
});

function generatedFixture(f,kind) {
  const valueFor=(index)=>{if(kind==='description')return {description:text+' Synthetic item '+index+'.'};let n=index;const entries=kind==='friction' ? Object.entries(en.FRICTION_OPTIONS) : [...en.GENRE_FLAGS.map(k=>[k,['yes','no','unknown']]),['primary_genre',en.PRIMARY_GENRES]];return Object.fromEntries(entries.map(([k,choices])=>{const v=choices[n%choices.length];n=Math.floor(n/choices.length);return[k,v];}));};
  const name=`enrich-gemini-${kind}-none.jsonl`;
  const draftFile=path.join(f.out,name);
  const rows=Array.from({length:100},(_,i)=>({schema:'mgpl-enrichment/1',qid:`Q${i+1}`,task:kind,
    context:'none',status:'ok',label:'generated',generated:valueFor(i),at:'2026-10-16T12:00:00Z',
    model:'synthetic-model',prompt_version:'synthetic-v1',run_id:'synthetic-run',attempt_id:'synthetic-attempt'}));
  if(kind==='friction'){rows[0].generated.save_system='checkpoints';rows[0].generated.cognitive_load='high';rows[0].sourced={save_anytime:true,source:'https://store.steampowered.com/app/101/'};}
  writeFileSync(draftFile,jsonl(rows));
  writeFileSync(path.join(f.cat,'wikidata.jsonl'),jsonl(rows.map((r,i)=>({qid:r.qid,label:`Synthetic Harbor ${i+1}`}))));
  const samples=path.join(f.tmp,'samples'); mkdirSync(samples);
  sample.draw({kind,inputs:[draftFile],seed:'wu034',out:samples,n:100,now:new Date(NOW)});
  const sheet=path.join(samples,`sample-${kind}-wu034.csv`);
  const table=sample.parseCsv(readFileSync(sheet,'utf8'));
  const verdictColumn=table[0].indexOf('verdict');
  for (const row of table.slice(1)) row[verdictColumn]='correct';
  writeFileSync(sheet,sample.toCsv(table));
  sample.score({sheet,now:new Date(NOW)});
  const summary=sheet.replace(/\.csv$/,'.summary.json');
  const accepted=JSON.parse(readFileSync(summary,'utf8'));
  accepted.accepted_by='Synthetic Operator'; accepted.accepted_at=new Date(NOW).toISOString();
  writeFileSync(summary,JSON.stringify(accepted));
  const promoted=path.join(f.tmp,'promoted.jsonl');
  writeFileSync(promoted,jsonl(rows.map(r=>({schema:'mgpl-promoted-embedding-input/2',qid:r.qid,kind,
    text_sha256:sha(sample.canonicalJson(r.generated)),promoted_at:new Date(NOW).toISOString(),
    sample_summary_sha256:sha(readFileSync(summary)),draft_file:name}))));
  return {kind,rows,draftFile,summary,promoted,
    args:['--run','--entry','#990','--text',kind,'--catalogue',f.cat,'--out',f.out,'--reserve','1','--batch','100','--promoted-input',promoted]};
}
for (const kind of ['friction','genre']) {
  test(`CLI-EMB-${kind}-gate: absent acceptance refuses before client or reservation`,async()=>{
    await fixture(async f=>{
      const g=generatedFixture(f,kind);
      await assert.rejects(em.main(g.args,{...f.deps,catalogue:f.cat}),e=>e.code==='WU034_EMB_SAMPLE_REQUIRED');
      assert.equal(f.clientCount(),0); assert.equal(f.seen.length,0); assert.equal(f.ledger().length,0);
    },{label:'EMB-2'});
  });
  test(`CLI-EMB-${kind}-accepted: scored accepted input embeds exactly its canonical text`,async()=>{
    await fixture(async f=>{
      const g=generatedFixture(f,kind);
      const before=readFileSync(g.draftFile);
      assert.equal(await em.main([...g.args,'--sample-summary',g.summary],{...f.deps,catalogue:f.cat}),0);
      const sent=f.seen.flatMap(s=>s.body.instances || []);
      assert.equal(sent.length,100);
      assert.deepEqual(sent.map(i=>i.content),g.rows.map(r=>sample.canonicalJson(r.generated)));
      assert.equal(new Set(sent.map(i=>i.content)).size,100,'fixture rows must be distinguishable');
      const vectors=readLines(path.join(f.out,`embed-descriptions-${kind}-text-embedding-005-768.jsonl`));
      assert.deepEqual(vectors.map(r=>r.qid),g.rows.map(r=>r.qid));
      assert.deepEqual(vectors.map(r=>r.text_sha256),g.rows.map(r=>sha(sample.canonicalJson(r.generated))));
      assert.deepEqual(vectors.map(r=>em.decodeVector(r.vector_f32le_b64)[0]),g.rows.map(r=>parseInt(sha(sample.canonicalJson(r.generated)).slice(0,6),16)/16777216));
      assert.deepEqual(readFileSync(g.draftFile),before);
      assert.equal(readLines(path.join(f.out,`embed-descriptions-${kind}-text-embedding-005-768.jsonl`)).length,100);
    },{label:'EMB-2'});
  });
  test(`CLI-EMB-${kind}-wrong-kind: description summary cannot authorize this kind`,async()=>{
    await fixture(async f=>{
      const g=generatedFixture(f,kind);
      const summary=JSON.parse(readFileSync(g.summary,'utf8')); summary.kind='description';
      writeFileSync(g.summary,JSON.stringify(summary));
      const promoted=readLines(g.promoted);for(const row of promoted)row.sample_summary_sha256=sha(readFileSync(g.summary));writeFileSync(g.promoted,jsonl(promoted));
      await assert.rejects(em.main([...g.args,'--sample-summary',g.summary],{...f.deps,catalogue:f.cat}),e=>e.code==='WU034_EMB_SAMPLE_KIND');
      assert.equal(f.clientCount(),0); assert.equal(f.ledger().length,0);
    },{label:'EMB-2'});
  });
  test(`CLI-EMB-${kind}-changed-input: acceptance cannot cover changed draft bytes`,async()=>{
    await fixture(async f=>{
      const g=generatedFixture(f,kind);
      writeFileSync(g.draftFile,readFileSync(g.draftFile,'utf8')+'\n');
      await assert.rejects(em.main([...g.args,'--sample-summary',g.summary],{...f.deps,catalogue:f.cat}),e=>e.code==='WU034_EMB_INPUT_HASH');
      assert.equal(f.clientCount(),0); assert.equal(f.ledger().length,0);
    },{label:'EMB-2'});
  });
}
test('CLI-JDG-entry: old S3 allowance cannot fund checking',async()=>{
  await fixture(async f=>{
    await assert.rejects(en.main([...f.args,'--task','check','--check-input',f.input],f.deps),e=>e.code==='WU034_MODE_ENTRY');
    assert.equal(f.clientCount(),0); assert.equal(f.ledger().length,0);
  },{label:'S3'});
});
test('CLI-EMB-entry: old EMB allowance cannot fund new title mode',async()=>{
  await fixture(async f=>{
    await assert.rejects(em.main(['--run','--entry','#990','--text','title','--catalogue',f.cat,'--out',f.out,'--reserve','1'],{...f.deps,catalogue:f.cat}),e=>e.code==='WU034_MODE_ENTRY');
    assert.equal(f.clientCount(),0); assert.equal(f.ledger().length,0);
  },{label:'EMB'});
});
test('CLI-JDG-retry: transient failure is a separate counted attempt',async()=>{
  await fixture(async f=>{
    const original=f.deps.baseFetch; let calls=0;
    f.deps.baseFetch=async(...args)=>++calls===1 ? new Response('{}',{status:503}) : original(...args);
    assert.equal(await en.main([...f.args,'--task','check','--check-input',f.input,'--limit','1'],f.deps),0);
    assert.equal(calls,2); assert.equal(f.ledger().filter(l=>l.type==='attempt').length,2);
    const results=f.outputs().filter(r=>r.task==='check');
    assert.equal(results.length,1); assert.equal(results[0].qid,'Q2');
  });
});
test('CLI-JDG-interrupt: finishes at most the in-flight batch and preserves inputs',async()=>{
  await fixture(async f=>{
    const before=readFileSync(f.input); const original=f.deps.baseFetch; let calls=0;
    f.deps.baseFetch=async(...args)=>{calls++;const result=await original(...args);f.deps.interrupts.emit('SIGINT');return result;};
    await en.main([...f.args,'--task','check','--check-input',f.input],f.deps);
    assert.equal(calls,1); assert.deepEqual(readFileSync(f.input),before);
    assert.equal(f.ledger().filter(l=>l.type==='attempt').length,1);
    assert.equal(f.ledger().filter(l=>l.type==='end').length,1);
  });
});
test('CLI-JDG-resume: changed source text is checked again under its new hash',async()=>{
  await fixture(async f=>{
    const args=[...f.args,'--task','check','--check-input',f.input,'--limit','1'];
    assert.equal(await en.main(args,f.deps),0);
    const rows=readLines(f.input); const changed=rows.find(r=>r.qid==='Q2');
    changed.source.url=changed.source.url.replace('oldid=1002','oldid=2002'); f.setSourceSuffix(' Additional synthetic fact.');
    writeFileSync(f.input,jsonl(rows));
    assert.equal(await en.main(args,f.deps),0);
    assert.deepEqual(f.seen.flatMap(r=>r.ids),['Q2','Q2']);
    const results=f.outputs().filter(r=>r.task==='check' && r.qid==='Q2');
    assert.equal(results.length,2);
    assert.notEqual(results[0].source_sha256,results[1].source_sha256);
  });
});

test('TITLE-only Wikidata and aliases are used with no Steam/description dependency',async()=>{
  await fixture(async f=>{
    const file=path.join(f.cat,'wikidata.jsonl');const rows=readLines(file);
    rows.push({qid:'Q4',label:'Cafe\u0301'});writeFileSync(file,jsonl(rows));
    writeFileSync(path.join(f.cat,'wikidata-xids.jsonl'),jsonl([{qid:'Q4',aliases:['\u{1F600}','\uFF21','Caf\u00e9','A']} ]));
    assert.equal(existsSync(path.join(f.out,'enrich-gemini-description-wikipedia.jsonl')),false);
    assert.equal(await em.main(['--run','--entry','#990','--text','title','--catalogue',f.cat,'--out',f.out,'--reserve','1'],f.deps),0);
    assert.deepEqual(f.seen.flatMap(r=>r.body.instances.map(i=>i.content)),['Synthetic Harbor 1','Synthetic Harbor 2','Synthetic Harbor 3','Caf\u00e9\nA\n\uFF21\n\u{1F600}']);
    assert.deepEqual(readLines(path.join(f.out,'embed-descriptions-title-text-embedding-005-768.jsonl')).map(r=>r.qid),['Q1','Q2','Q3','Q4']);
  },{label:'EMB-2'});
});
test('TITLE never reuses an ok description or its text',async()=>{
  await fixture(async f=>{
    writeFileSync(path.join(f.out,'enrich-gemini-description-none.jsonl'),jsonl([{schema:'mgpl-enrichment/1',qid:'Q1',task:'description',status:'ok',label:'generated',generated:{description:'DESCRIPTION_SENTINEL_NOT_TITLE'},at:new Date(NOW).toISOString()}]));
    assert.equal(await em.main(['--run','--entry','#990','--text','title','--catalogue',f.cat,'--out',f.out,'--reserve','1'],f.deps),0);
    const sent=f.seen.flatMap(r=>r.body.instances.map(i=>i.content));
    assert.equal(sent.length,3);assert.ok(sent.every(s=>!s.includes('DESCRIPTION_SENTINEL')));
  },{label:'EMB-2'});
});
test('TITLE too-long aliases skip exactly that QID and never truncate',async()=>{
  await fixture(async f=>{
    writeFileSync(path.join(f.cat,'wikidata-xids.jsonl'),jsonl([{qid:'Q1',aliases:['x'.repeat(2100)]}]));
    assert.equal(await em.main(['--run','--entry','#990','--text','title','--catalogue',f.cat,'--out',f.out,'--reserve','1'],f.deps),0);
    const vectors=readLines(path.join(f.out,'embed-descriptions-title-text-embedding-005-768.jsonl'));
    assert.deepEqual(vectors.map(r=>r.qid),['Q2','Q3']);
    const aggregate=JSON.parse(readFileSync(path.join(f.out,readdirSync(f.out).find(n=>n.endsWith('aggregate.json'))),'utf8'));
    assert.equal(aggregate.games.too_long,1);
  },{label:'EMB-2'});
});
for(const flag of ['--promoted-input','--sample-summary'])test(`TITLE refuses ${flag}`,async()=>{
  await fixture(async f=>{
    await assert.rejects(em.main(['--text','title','--catalogue',f.cat,'--out',f.out,flag,f.input],f.deps),e=>e.code==='WU034_TITLE_FLAGS');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  },{label:'EMB-2'});
});
for(const [name,mutate]of [
  ['wrong kind',rows=>{rows[0].kind='genre';}],
  ['bad hash',rows=>{rows[0].text_sha256='not-hex';}],
  ['unreviewed hash',rows=>{rows[0].text_sha256=sha('unreviewed');}],
  ['duplicate QID',rows=>rows.push({...rows[0]})],
  ['unknown QID',rows=>{rows[0].qid='Q99999';}],
  ['missing draft file',rows=>{delete rows[0].draft_file;}],
  ['effective value field is not the reviewed hash',rows=>{rows[0].value={save_system:'save_anywhere'};}],
])test(`E promoted input rejects ${name} before reservation`,async()=>{
  await fixture(async f=>{
    const g=generatedFixture(f,'friction');const rows=readLines(g.promoted);mutate(rows);writeFileSync(g.promoted,jsonl(rows));
    await assert.rejects(em.main([...g.args,'--sample-summary',g.summary],f.deps),e=>e.code==='WU034_EMB_PROMOTED_INPUT');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  },{label:'EMB-2'});
});
test('E Steam override selection embeds reviewed checkpoints, not effective save-anywhere',async()=>{
  await fixture(async f=>{
    const g=generatedFixture(f,'friction');const original=g.rows[0].generated;
    const effective={...original,save_system:'save_anywhere'};
    assert.notEqual(sha(sample.canonicalJson(effective)),readLines(g.promoted)[0].text_sha256);
    assert.equal(await em.main([...g.args,'--sample-summary',g.summary],f.deps),0);
    const texts=f.seen.flatMap(r=>r.body.instances.map(i=>i.content));
    assert.equal(texts[0],sample.canonicalJson(original));
  },{label:'EMB-2'});
});
for(const [name,mutate,code]of [
  ['non-HTTPS source',r=>{r[0].source.url='http://en.wikipedia.org/w/index.php?title=X&oldid=1';},'WU034_CHECK_URL'],
  ['unapproved source host',r=>{r[0].source.url='https://example.org/w/index.php?title=X&oldid=1';},'WU034_CHECK_URL'],
  ['bad hex',r=>{r[0].description_sha256='XYZ';},'WU034_CHECK_DIGEST'],
  ['duplicate QID',r=>r.push({...r[0]}),'WU034_CHECK_DUPLICATE'],
  ['blank description',r=>{r[0].description=' ';r[0].description_sha256=sha(' ');},'WU034_CHECK_INPUT'],
  ['persisted source text',r=>{r[0].source.text=sourceText;},'WU034_CHECK_INPUT'],
])test(`G input rejects ${name} before client/reservation`,async()=>{
  await fixture(async f=>{
    const rows=readLines(f.input);mutate(rows);writeFileSync(f.input,jsonl(rows));
    await assert.rejects(en.main([...f.args,'--task','check','--check-input',f.input],f.deps),e=>e.code===code);
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  });
});
test('G default dry-run validates all rows with zero source or model requests',async()=>{
  await fixture(async f=>{
    let fetched=0;f.deps.wikiFetch=async()=>{fetched++;throw new Error('dry-run source fetch');};
    assert.equal(await en.main(['--task','check','--check-input',f.input],f.deps),0);
    assert.equal(fetched,0);assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  });
});
test('G unbilled source validation pins revisions but opens no run',async()=>{
  await fixture(async f=>{
    const original=f.deps.wikiFetch;let fetched=0;f.deps.wikiFetch=async(...a)=>{fetched++;return original(...a);};
    assert.equal(await en.main(['--task','check','--check-input',f.input,'--validate-sources'],f.deps),0);
    assert.equal(fetched,3);assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
    assert.equal(readdirSync(f.out).length,0);
  });
});
test('G source-copy reason is rejected and no source excerpt reaches outputs or aggregates',async()=>{
  await fixture(async f=>{
    f.setReason(sourceText);
    await en.main([...f.args,'--task','check','--check-input',f.input,'--limit','1'],f.deps);
    const rows=f.outputs().filter(r=>r.task==='check');assert.equal(rows.length,1);
    assert.equal(rows[0].status,'rejected');assert.equal(rows[0].generated,null);assert.equal(rows[0].reason_code,'WU034_REASON_COPY');
    for(const name of readdirSync(f.out))assert.ok(!readFileSync(path.join(f.out,name),'utf8').includes(sourceText));
    assert.ok(!readFileSync(f.input,'utf8').includes(sourceText));
    assert.ok(!JSON.stringify(f.ledger()).includes(sourceText));
  });
});
for(const field of ['description','model','prompt_version'])test(`G resume requeues changed ${field}`,async()=>{
  await fixture(async f=>{
    const input=readLines(f.input).filter(r=>r.qid==='Q2');writeFileSync(f.input,jsonl(input));
    const args=[...f.args,'--task','check','--check-input',f.input];
    assert.equal(await en.main(args,f.deps),0);
    if(field==='description'){input[0].description+=' Added draft detail.';input[0].description_sha256=sha(input[0].description);writeFileSync(f.input,jsonl(input));}
    else{const file=path.join(f.out,'enrich-gemini-check.jsonl');const rows=readLines(file);rows[0][field]=field==='model'?'gemini-3.7-flash':'s3-check-v0';writeFileSync(file,jsonl(rows));}
    assert.equal(await en.main(args,f.deps),0);assert.equal(f.seen.length,2);
  });
});
test('G unchanged input is skipped before another reservation',async()=>{
  await fixture(async f=>{
    writeFileSync(f.input,jsonl(readLines(f.input).filter(r=>r.qid==='Q2')));
    const args=[...f.args,'--task','check','--check-input',f.input];assert.equal(await en.main(args,f.deps),0);
    const before=f.ledger().filter(r=>r.type==='reservation').length;
    f.deps.wikiFetch=async()=>{assert.fail('completed resume must not fetch Wikipedia');};
    await assert.rejects(en.main(args,f.deps),e=>e.code==='WU034_NOTHING_TO_DO');
    assert.equal(f.seen.length,1);assert.equal(f.ledger().filter(r=>r.type==='reservation').length,before);
  });
});
test('JDG refuses legacy friction even with otherwise runnable synthetic input',async()=>{
  await fixture(async f=>{
    await assert.rejects(en.main([...f.args,'--task','friction','--catalogue',f.cat],f.deps),e=>e.code==='WU034_MODE_ENTRY');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  },{label:'JDG'});
});
test('EMB-2 refuses legacy default description despite a valid accepted sample',async()=>{
  await fixture(async f=>{
    const g=generatedFixture(f,'description');
    await assert.rejects(em.main(['--run','--entry','#990','--catalogue',f.cat,'--out',f.out,'--reserve','1','--sample-summary',g.summary],f.deps),e=>e.code==='WU034_MODE_ENTRY');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  },{label:'EMB-2'});
});
for(const flags of [['--context','wikipedia'],['--top','10'],['--fill-from','wikipedia'],['--catalogue','not-used']])test(`G refuses incompatible ${flags[0]}`,async()=>{
  await fixture(async f=>{
    await assert.rejects(en.main(['--task','check','--check-input',f.input,...flags],f.deps),e=>e.code==='WU034_CHECK_FLAGS');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  });
});
test('TITLE resume ignores a different kind even with the same text hash',async()=>{
  await fixture(async f=>{
    const file=path.join(f.out,'embed-descriptions-title-text-embedding-005-768.jsonl');
    writeFileSync(file,jsonl([{schema:em.SCHEMA,qid:'Q1',model:em.MODEL,dimensions:768,text_kind:'friction',
      text_sha256:sha('Synthetic Harbor 1'),vector_f32le_b64:em.encodeVector(Array(768).fill(0))}]));
    assert.equal(await em.main(['--run','--entry','#990','--text','title','--catalogue',f.cat,'--out',f.out,'--reserve','1'],f.deps),0);
    assert.equal(f.seen.flatMap(s=>s.body.instances).length,3);
    assert.equal(readLines(file).filter(r=>r.text_kind==='title').length,3);
  },{label:'EMB-2'});
});
test('G rejects a returned revision mismatch without a billed request',async()=>{
  await fixture(async f=>{
    f.deps.wikiFetch=async()=>new Response(JSON.stringify({query:{pages:[{title:'Synthetic Source',revisions:[{revid:9999,slots:{main:{contentmodel:'wikitext',content:sourceText}}}]}]}}),{status:200,headers:{'content-type':'application/json'}});
    await assert.rejects(en.main(['--task','check','--check-input',f.input,'--validate-sources'],f.deps),e=>e.code==='WU034_CHECK_SOURCE');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  });
});

// Revision-3 regressions: all content is invented and remains offline.
test('G source profile strips a long nested infobox before clipping prose',()=>{
  const prose='Invented sailors trade supplies and rebuild coastal beacons.';
  const raw='<!-- hidden -->{{Infobox game|notes='+ 'x'.repeat(2200)+'{{nested|x={{{parameter|fallback}}}}}}} <REF name="a">hidden</REF>[[File:Map.png|thumb|[[Hidden]]]] '+prose;
  assert.equal(en.checkSourceText(raw),prose);
  assert.equal(en.checkSourceText('[[Invented title|Displayed title]] &amp; boats'), 'Displayed title & boats');
  assert.equal(Array.from(en.checkSourceText('😀'.repeat(1600))).length,1500);
  assert.throws(()=>en.checkSourceText('{{unclosed'),e=>e.code==='WU034_CHECK_SOURCE');
});
test('G validate-sources honors limit and popularity order',async()=>{
  await fixture(async f=>{
    const original=f.deps.wikiFetch;const ids=[];
    f.deps.wikiFetch=async(url,...rest)=>{ids.push(Number(new URL(url).searchParams.get('revids')));return original(url,...rest);};
    assert.equal(await en.main(['--task','check','--check-input',f.input,'--validate-sources','--limit','1'],f.deps),0);
    assert.deepEqual(ids,[1002]);assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  });
});
for(const words of [7,8])test('G description-copy boundary '+words+' words',async()=>{
  await fixture(async f=>{
    f.setReason(text.split(/\s+/).slice(0,words).join(' '));
    await en.main([...f.args,'--task','check','--check-input',f.input,'--limit','1'],f.deps);
    const row=f.outputs().find(r=>r.task==='check');assert.ok(row);
    assert.equal(row.status,words===8?'rejected':'ok');
    if(words===8){assert.equal(row.generated,null);assert.equal(row.reason_code,'WU034_REASON_COPY');}
  });
});
test('E strict subset is embedded in numeric order independent of snapshot order',async()=>{
  await fixture(async f=>{
    const g=generatedFixture(f,'friction');const all=readLines(g.promoted);
    writeFileSync(g.promoted,jsonl([all[9],all[1],all[0]]));
    assert.equal(await em.main([...g.args,'--sample-summary',g.summary],f.deps),0);
    const output=f.outputs().filter(r=>r.text_kind==='friction');assert.deepEqual(output.map(r=>r.qid),['Q1','Q2','Q10']);
    assert.deepEqual(output.map(r=>r.text_sha256),[all[0],all[1],all[9]].map(r=>r.text_sha256));
    const aggregates=readdirSync(f.out).filter(n=>n.endsWith('.aggregate.json')).map(n=>JSON.parse(readFileSync(path.join(f.out,n),'utf8')));
    assert.ok(aggregates.some(a=>a.games.not_selected===97));
  },{label:'EMB-2'});
});
for(const dry of [false,true])test('E stale summary digest refuses '+(dry?'dry-run':'run'),async()=>{
  await fixture(async f=>{
    const g=generatedFixture(f,'friction');const rows=readLines(g.promoted);rows[0].sample_summary_sha256='0'.repeat(64);writeFileSync(g.promoted,jsonl(rows));
    await assert.rejects(em.main([...g.args.filter(a=>!dry||a!=='--run'),'--sample-summary',g.summary],f.deps),e=>e.code==='WU034_EMB_PROMOTED_INPUT');
    assert.equal(f.clientCount(),0);assert.equal(f.ledger().length,0);
  },{label:'EMB-2'});
});

for(const url of [
  'https://en.wikipedia.org/w/index.php?oldid=1002&title=Synthetic_Source',
  'https://en.wikipedia.org/w/index.php?title=Synthetic%20Source&oldid=1002',
])test('G resume canonical URL equivalence '+url,async()=>{
  await fixture(async f=>{
    const input=readLines(f.input).filter(r=>r.qid==='Q2');writeFileSync(f.input,jsonl(input));
    const args=[...f.args,'--task','check','--check-input',f.input];
    assert.equal(await en.main(args,f.deps),0);
    const before=f.ledger().filter(r=>r.type==='reservation').length;
    input[0].source.url=url;writeFileSync(f.input,jsonl(input));
    f.deps.wikiFetch=async()=>{assert.fail('equivalent pinned URL must reuse completed identity without fetching');};
    await assert.rejects(en.main(args,f.deps),e=>e.code==='WU034_NOTHING_TO_DO');
    assert.equal(f.seen.length,1);assert.equal(f.ledger().filter(r=>r.type==='reservation').length,before);
  });
});
