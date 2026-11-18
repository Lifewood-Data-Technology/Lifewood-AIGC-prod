import {lex,word,identifier} from '../../db/mysql/sql.ts';
const canonical=source=>{const tokens=lex(source);while(tokens.at(-1)?.text===';')tokens.pop();return tokens.map(t=>t.kind==='word'?t.text.toUpperCase():t.kind==='quoted'?identifier(t).toUpperCase():t.text).join(' ');};
export async function verifyTriggers(c,statements){
 const expected=[];
 for(const sql of statements){const tokens=lex(sql),start=tokens.findIndex(t=>word(t,'TRIGGER'));if(start<0)continue;const name=identifier(tokens[start+1]);const row=tokens.findIndex(t=>word(t,'ROW'));const body=tokens.slice(row+1).map(t=>t.text).join(' ');const on=tokens.findIndex(t=>word(t,'ON'));
  expected.push(name);
  const [actual]=await c.execute('SELECT ACTION_STATEMENT,ACTION_TIMING,EVENT_MANIPULATION,EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?',[name]);
  if(actual.length!==1||actual[0].ACTION_TIMING!=='BEFORE'||actual[0].EVENT_MANIPULATION!==tokens[start+3].text.toUpperCase()||actual[0].EVENT_OBJECT_TABLE!==identifier(tokens[on+1])||canonical(actual[0].ACTION_STATEMENT)!==canonical(body))throw Error('Missing or changed administrator trigger: '+name);
 }
 const [installed]=await c.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
 if(installed.length!==expected.length||installed.some(trigger=>!expected.includes(trigger.TRIGGER_NAME)))throw Error('Unexpected administrator trigger; no schema changes authorized');
}
