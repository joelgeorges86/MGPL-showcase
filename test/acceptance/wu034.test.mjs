// Independently authored WU-034 contract tests. Synthetic fixtures; no SDK or billed call.
// Run with MGPL_WU034_ROOT set to an isolated source tree. Default: this kit's pinned snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MGPL_WU034_ROOT || path.resolve(here,'../..');
globalThis.fetch = () => { throw new Error('Network is forbidden in WU-034 contract tests'); };
const load = p => import(pathToFileURL(path.join(root, p)).href);
const enrich = await load('scripts/catalogue/enrich-gemini.mjs');
const embed = await load('scripts/catalogue/embed-descriptions.mjs');
const guard = await load('scripts/probes/act08/lib.mjs');
const sample = await load('scripts/catalogue/sample-check.mjs');
const game = {id:'Q1',title:'Lantern Harbor'};

test('JDG-01: check schema permits exactly the three review verdicts', () => {
  const item = enrich.responseSchema('check').properties.games.items;
  assert.deepEqual([...item.properties.verdict.enum].sort(),['consistent','contradicts','doubtful'].sort());
  assert.ok(item.required.includes('reason'));
});
test('JDG-02: valid check verdicts pass local validation and unknown verdicts fail', () => {
  for (const verdict of ['consistent','doubtful','contradicts']) {
    assert.equal(enrich.itemProblem('check',{id:'Q1',verdict,reason:'Synthetic evidence.',confidence:.8}),null);
  }
  assert.equal(typeof enrich.itemProblem('check',{id:'Q1',verdict:'approved',reason:'Synthetic evidence.',confidence:.8}),'string');
});
test('JDG-03: checker has its own model and a supported thinking setting', () => {
  const params = enrich.requestParams('check',[game]);
  assert.equal(params.model,'gemini-3.8-flash');
  assert.equal(params.config.thinkingConfig.thinkingLevel,'LOW');
  assert.equal(params.config.maxOutputTokens,768);
  assert.equal(params.config.tools,undefined);
});
for (const kind of ['title','friction','genre']) {
  test(`EMB-01-${kind}: output file isolates ${kind} vectors`, () => {
    assert.equal(path.basename(embed.vectorsFile('/synthetic-output',kind)),
      `embed-descriptions-${kind}-text-embedding-005-768.jsonl`);
  });
}
test('EMB-02: title text preserves the label and deterministic distinct aliases', () => {
  assert.equal(typeof embed.embeddingText,'function','canonical embedding input boundary must exist');
  assert.equal(embed.embeddingText('title',{label:' Lantern Harbor ',aliases:['Port Lantern','Lantern Harbor','Amber Port','Port Lantern','']}),
    'Lantern Harbor\nAmber Port\nPort Lantern');
});
test('COMPAT-01: existing default description filename and text stay unchanged', () => {
  assert.equal(path.basename(embed.vectorsFile('/synthetic-output')),'embed-descriptions-text-embedding-005-768.jsonl');
  assert.equal(embed.textFor('Lantern Harbor','A synthetic description.'),'Lantern Harbor. A synthetic description.');
});

const sha = value => createHash('sha256').update(value).digest('hex');
function acceptedSummary(kind, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(),'mgpl-wu034-sample-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));
  try {
    const sheet = 'synthetic scored sheet bytes\n';
    const meta = '{}\n';
    const snapshot = [{name:`enrich-gemini-${kind}-none.jsonl`,sha256:sha('synthetic draft bytes'),records:[]}];
    const summary = {schema:'mgpl-sample-check-summary/1',kind,accepted_by:'Synthetic Operator',
      accepted_at:'2026-10-16T12:00:00Z',n:100,complete:true,meets_line:true,
      counts:{unchecked:0,wrong:0},sheet:`sample-${kind}-synthetic.csv`,
      sheet_sha256:sha(sheet),meta_sha256:sha(meta),
      inputs:snapshot.map(f=>({file:f.name,sha256:f.sha256}))};
    writeFileSync(path.join(dir,summary.sheet),sheet);
    writeFileSync(path.join(dir,summary.sheet.replace(/\.csv$/,'.meta.json')),meta);
    const file = path.join(dir,`sample-${kind}-synthetic.summary.json`);
    writeFileSync(file,JSON.stringify(summary));
    return fn(file,snapshot);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
}
for (const kind of ['friction','genre']) {
  test(`EMB-03-${kind}: its own accepted sample kind passes the acceptance boundary`, () => {
    acceptedSummary(kind,(file,snapshot)=>{
      const accepted = embed.checkAcceptance(file,snapshot,kind);
      assert.equal(accepted.ordered[0].name,snapshot[0].name);
    });
  });
  test(`EMB-04-${kind}: description acceptance cannot authorize ${kind}`, () => {
    acceptedSummary('description',(file,snapshot)=>{
      assert.throws(()=>embed.checkAcceptance(file,snapshot,kind),e=>e.code==='WU034_EMB_SAMPLE_KIND');
    });
  });
}
test('EMB-05: title acceptance needs no sample summary', () => {
  const accepted = embed.checkAcceptance(undefined,[],'title');
  assert.equal(accepted.record,null);
  assert.deepEqual(accepted.ordered,[]);
});
for (const kind of ['friction','genre']) {
  test(`EMB-text-${kind}: text is the reviewed canonical value and preserves unknowns`,()=>{
    assert.equal(typeof embed.embeddingText,'function','canonical embedding input boundary must exist');
    const value=kind==='friction' ? Object.fromEntries(Object.keys(enrich.FRICTION_OPTIONS).map(k=>[k,'unknown'])) :
      {...Object.fromEntries(enrich.GENRE_FLAGS.map(k=>[k,'unknown'])),primary_genre:enrich.PRIMARY_GENRES[0]};
    const actual=embed.embeddingText(kind,{[kind]:value});
    assert.equal(actual,sample.canonicalJson(value));
    assert.ok(actual.includes('"unknown"'));
    const changed={...value};
    if(kind==='friction') changed.cognitive_load='high';
    else changed.primary_genre=enrich.PRIMARY_GENRES[1];
    assert.notEqual(embed.embeddingText(kind,{[kind]:changed}),actual);
  });
}
test('LEDGER-label: parser preserves a label for mode admission without changing numeric IDs',()=>{
  const parsed=guard.parseAuthorizations(readFileSync(path.join(root,'AGENTS.md'),'utf8'));
  const entry=parsed.entries.find(e=>e.id==='#158');
  assert.equal(entry.id,'#158');
  assert.equal(entry.label,'S3');
});
test('TITLE-Unicode: NFC normalization and scalar sort differ from UTF-16 sort',()=>{
  assert.equal(typeof embed.embeddingText,'function');
  assert.equal(embed.embeddingText('title',{label:'Cafe\u0301',aliases:['\u{1F600}','\uFF21','Caf\u00e9',' Cafe\u0301 ','A']}),
    'Caf\u00e9\nA\n\uFF21\n\u{1F600}');
});
const scriptEn='scripts/catalogue/enrich-gemini.mjs',scriptEm='scripts/catalogue/embed-descriptions.mjs';
const matrix=[['S3',scriptEn,['description','friction','genre']],['JDG',scriptEn,['check']],
  ['EMB',scriptEm,['description']],['EMB-2',scriptEm,['title','friction','genre']]];
for(const label of ['S3','JDG','EMB','EMB-2',null])for(const script of [scriptEn,scriptEm])for(const mode of ['description','friction','genre','check','title']){
  test(`MODE ${label ?? 'unlabelled'} / ${script===scriptEn?'enrich':'embed'} / ${mode}`,()=>{
    assert.equal(typeof guard.assertEntryMode,'function','shared mode enforcement must exist');
    const entry={id:'#990',label,script};
    const allowed=matrix.some(([l,s,modes])=>l===label && s===script && modes.includes(mode));
    if(allowed)assert.doesNotThrow(()=>guard.assertEntryMode(entry,{script,mode}));
    else assert.throws(()=>guard.assertEntryMode(entry,{script,mode}),e=>e.code==='WU034_MODE_ENTRY' && e.check==='mode');
  });
}
const validCheck={id:'Q1',confidence:.8,verdict:'consistent',reason:'Independent synthetic assessment.'};
for(const [name,over]of [['blank reason',{reason:' '}],['long reason',{reason:'x'.repeat(601)}],
  ['confidence above range',{confidence:1.1}],['confidence below range',{confidence:-.1}],
  ['unknown field',{extra:'unrequested'}],['unknown verdict',{verdict:'approved'}]]){
  test(`CHECK validation: ${name}`,()=>assert.equal(typeof enrich.itemProblem('check',{...validCheck,...over}),'string'));
}
for(const [name,items]of [['unknown ID',[validCheck,{...validCheck,id:'Q999'}]],['duplicate ID',[validCheck,validCheck]],['missing ID',[]]]){
  test(`CHECK batch rejects ${name}`,()=>{
    const result=enrich.judgeBatch('check',[game],{games:items},new Map());
    assert.equal(result.get('Q1').status,'failed');
    assert.equal(result.get('Q1').generated ?? null,null);
  });
}
