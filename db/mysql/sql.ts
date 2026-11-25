/** A deliberately small SQL lexer. Quoted literals are never rewritten.
 * SQLite-only statement forms are lowered explicitly by the driver; unsupported
 * constructs fail closed rather than falling back to a different database. */
export type Value = string | number | null;
export type Token = { text:string; kind:'word'|'quoted'|'string'|'symbol'|'param'; bind?:number; value?:Value };
export function lex(source:string):Token[]{
 const out:Token[]=[];let i=0,b=0;
 while(i<source.length){const c=source[i];if(/\s/.test(c)){i++;continue;}
  if(source.startsWith('--',i)){const end=source.indexOf('\n',i);i=end<0?source.length:end+1;continue;}
  if(source.startsWith('/*',i)){const end=source.indexOf('*/',i+2);if(end<0)throw Error('Unclosed SQL comment');i=end+2;continue;}
  if(c==='\''||c==='"'||c==='`'){const start=i++;let closed=false;while(i<source.length){if(source[i++]===c){if(source[i]===c){i++;continue;}closed=true;break;}}if(!closed)throw Error('Unclosed SQL literal');out.push({text:source.slice(start,i),kind:c==='\''?'string':'quoted'});continue;}
  if(c==='?'){out.push({text:c,kind:'param',bind:b++});i++;continue;}
  const word=source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/);if(word){out.push({text:word[0],kind:'word'});i+=word[0].length;continue;}
  const numeric=source.slice(i).match(/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/);if(numeric){out.push({text:numeric[0],kind:'symbol'});i+=numeric[0].length;continue;}
  const op=['<=>','||','<>','!=','<=','>=','=='].find(o=>source.startsWith(o,i));if(op){out.push({text:op==='=='?'=':op,kind:'symbol'});i+=op.length;continue;}
  out.push({text:c,kind:'symbol'});i++;
 }return out;
}
export const word=(t:Token|undefined,s:string)=>!!t&&t.kind==='word'&&t.text.toUpperCase()===s.toUpperCase();
export const identifier=(t:Token)=>t.kind==='quoted'?t.text.slice(1,-1).replaceAll(t.text[0]+t.text[0],t.text[0]):t.text;
export const quote=(s:string)=>'`'+s.replaceAll('`','``')+'`';
export const param=(v:Value):Token=>({kind:'param',text:'?',value:v});
export function matching(ts:Token[],start:number){let depth=0;for(let i=start;i<ts.length;i++){if(ts[i].text==='(')depth++;if(ts[i].text===')'&&--depth===0)return i;}throw Error('Unbalanced SQL');}
export function findTop(ts:Token[],name:string,start=0){let depth=0;for(let i=start;i<ts.length;i++){if(ts[i].text==='(')depth++;else if(ts[i].text===')')depth--;else if(depth===0&&word(ts[i],name))return i;}return -1;}
export function split(ts:Token[],separator=','){let depth=0,start=0;const parts:Token[][]=[];for(let i=0;i<ts.length;i++){if(ts[i].text==='(')depth++;else if(ts[i].text===')')depth--;else if(depth===0&&ts[i].text===separator){parts.push(ts.slice(start,i));start=i+1;}}parts.push(ts.slice(start));return parts;}
export function bindTokens(ts:Token[],values:Value[]){if(ts.some(t=>t.kind==='param'&&t.bind!==undefined&&t.bind>=values.length))throw Error('Missing SQL bind value');return ts.map(t=>t.kind==='param'?param(t.bind===undefined?t.value??null:values[t.bind]):t);}
const raw=(s:string)=>lex(s);
const tableClauses = new Set([
 'AS', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW',
 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
 'OUTER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'ON', 'USING', 'RETURNING',
 'FOR', 'INDEXED', 'NOT',
]);

function isTableAlias(token: Token | undefined): boolean {
 return token?.kind === 'quoted' || (token?.kind === 'word' && !tableClauses.has(token.text.toUpperCase()));
}

export function render(tokens:Token[],values:Value[]=[],previousChanges=0):{sql:string;values:Value[]}{
 const bound=bindTokens(tokens,values);const result:Value[]=[];
 let aliasIndex = 0;
 let reservedIdentifiers: Set<string> | undefined;
 function nextJsonAlias(): string {
  // An alias later in the input can be referenced by an earlier or nested expression.
  reservedIdentifiers ??= new Set(tokens
   .filter(token => token.kind === 'word' || token.kind === 'quoted')
   .map(token => identifier(token).toLowerCase()));
  let alias: string;
  do { alias = `json_rows_${++aliasIndex}`; } while (reservedIdentifiers.has(alias));
  return alias;
 }
 function emit(ts:Token[]):string{
  const out:string[]=[];
  for(let i=0;i<ts.length;i++){
   const t=ts[i];
   if(t.kind==='param'){result.push(t.value??null);out.push('?');continue;}
   if(t.kind==='string'){// NO_BACKSLASH_ESCAPES keeps SQLite string contents literal.
    out.push(t.text);continue;
   }
   if(t.kind==='quoted'){out.push(quote(identifier(t)));continue;}
   if(t.kind==='word'&&ts[i+1]?.text==='('){
    const end=matching(ts,i+1),args=split(ts.slice(i+2,end)),name=t.text.toLowerCase();
    if(name==='randomblob'){if(args.length!==1||args[0].length!==1||args[0][0].text!=='16')throw Error('Unsupported random byte count');out.push('RANDOM_BYTES(16)');i=end;continue;}
    if(name==='changes'){if(args[0].length)throw Error('Unsupported changes()');out.push(String(previousChanges));i=end;continue;}
    if(name==='json_each'){
     if(args.length!==1)throw Error('Unsupported JSON iterator');
     let last = end;
     const hasAs = word(ts[end + 1], 'AS');
     const aliasIndexInTokens = end + (hasAs ? 2 : 1);
     const token = ts[aliasIndexInTokens];
     let alias: string;
     if (isTableAlias(token)) {
      alias = identifier(token);
      last = aliasIndexInTokens;
     } else {
      if (hasAs || token?.kind === 'string') throw Error('Expected an identifier for json_each alias');
      alias = nextJsonAlias();
     }
     const source=emit(args[0]);out.push(`(SELECT ordinality-1 AS \`key\`, CASE WHEN JSON_TYPE(item)='NULL' COLLATE utf8mb4_bin THEN NULL ELSE JSON_UNQUOTE(item) END COLLATE utf8mb4_0900_bin AS value FROM JSON_TABLE(${source}, '$[*]' COLUMNS (ordinality FOR ORDINALITY,item JSON PATH '$')) AS jt) AS ${quote(alias)}`);
     i=last;continue;
    }
    if(name==='json_extract'){
     if(args.length!==2)throw Error('Unsupported JSON extraction');
     // JSON_UNQUOTE defaults to utf8mb4_bin; SQL literals and the schema use
     // utf8mb4_0900_bin. Explicit result collation avoids coercible-expression
     // conflicts while retaining binary comparisons and SQL null propagation.
     out.push(`CASE WHEN JSON_TYPE(JSON_EXTRACT(${emit(args[0])},${emit(args[1])}))='NULL' COLLATE utf8mb4_bin THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(${emit(args[0])},${emit(args[1])})) END COLLATE utf8mb4_0900_bin`);i=end;continue;
    }
    if(name==='strftime'){
     const signature=args.map(a=>a.map(t=>t.text).join(''));
     if(signature[0]!=="'%Y-%m-%dT%H:%M:%fZ'"||signature[1]!=="'now'"||signature.length>3||signature[2]&&signature[2]!=="'-30 minutes'")throw Error('Unsupported time expression');
     const at=signature[2]?'DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE)':'UTC_TIMESTAMP(3)';out.push(`CONCAT(DATE_FORMAT(${at},'%Y-%m-%dT%H:%i:%s.'),LEFT(DATE_FORMAT(${at},'%f'),3),'Z')`);i=end;continue;
    }
    if(name==='date'&&args.length===2&&args[1][0]?.text==="'+8 hours'"){
     out.push(`DATE_FORMAT(DATE_ADD(STR_TO_DATE(REPLACE(REPLACE(${emit(args[0])},'T',' '),'Z',''),'%Y-%m-%d %H:%i:%s.%f'),INTERVAL 8 HOUR),'%Y-%m-%d')`);i=end;continue;
    }
    const fn=(name==='max'||name==='min')&&args.length>1?(name==='max'?'GREATEST':'LEAST'):t.text;
    out.push(fn+'('+args.map(a=>emit(a)).join(',')+')');i=end;continue;
   }
   if(word(t,'IS')&&ts[i+1]?.kind==='param'){out.push('<=>');continue;}
   if(word(t,'INTEGER')){out.push('SIGNED');continue;}
   if(word(t,'KEY')){out.push('`key`');continue;}
   out.push(t.text);
  }return out.join(' ');
 }
 return {sql:emit(bound),values:result};
}
export function substituted(ts:Token[],incoming:Record<string,Value>):Token[]{const out:Token[]=[];for(let i=0;i<ts.length;i++){if(word(ts[i],'excluded')&&ts[i+1]?.text==='.'&&ts[i+2]){const name=identifier(ts[i+2]);if(!(name in incoming))throw Error('Unknown incoming column');out.push(param(incoming[name]));i+=2;}else out.push(ts[i]);}return out;}
export function tokens(s:string){return raw(s);}
