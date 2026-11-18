export interface DatabaseResult<T = Record<string,unknown>> {
 results:T[]; success:boolean; meta:{changes:number;last_row_id?:number;duration?:number;[key:string]:unknown};
}
export interface DatabaseStatement {
 bind(...values:unknown[]):DatabaseStatement;
 first<T=Record<string,unknown>>(column?:string):Promise<T|null>;
 all<T=Record<string,unknown>>():Promise<DatabaseResult<T>>;
 run<T=Record<string,unknown>>():Promise<DatabaseResult<T>>;
 raw<T=unknown[]>():Promise<T[]>;
}
export interface Database {
 prepare(sql:string):DatabaseStatement;
 batch<T=Record<string,unknown>>(statements:DatabaseStatement[]):Promise<DatabaseResult<T>[]>;
 exec(sql:string):Promise<{count:number;duration:number}>;
}
