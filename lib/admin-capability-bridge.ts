import type {DirectorySnapshot} from './admin-directory';
import type {AdminAction} from './admin-authorization';
/** Existing endpoint capabilities remain distinct from object scope and workflow eligibility. */
export const capabilityActions = {
 'customers.manage':['customers.write'],
 'requests.create':['projects.brief'],
 'projects.manage':['projects.write','projects.assign'],
 'standards.manage':['standards.manage'],
 'files.upload':['files.write'],
 'assets.manage':['assets.manage'],
 'quality.review':['tasks.review'],
 'delivery.manage':['delivery.confirm'],
 'accounts.manage':['users.manage'],
 'system.manage':['parameters.manage'],
} as const satisfies Record<string,readonly AdminAction[]>;
export type LegacyCapability=keyof typeof capabilityActions;
export type CapabilitySet=Record<LegacyCapability,boolean>;
/** Unassigned legacy accounts are untouched. Explicit role assignments replace role defaults;
 * per-account denials still win. This never widens a customer/project/task query by itself. */
export function resolveRoleCapabilities(directory:DirectorySnapshot,email:string,administrator:boolean,legacy:CapabilitySet,denied:ReadonlySet<LegacyCapability>):CapabilitySet {
 if(administrator)return {...legacy};
 const membership=directory.memberships.find(member=>member.email===email);
 if(!membership)return {...legacy};
 const role=directory.roles.find(candidate=>candidate.id===membership.roleId);
 return Object.fromEntries(Object.entries(capabilityActions).map(([key,required])=>[key,Boolean(role?.enabled&&required.every(action=>role.permissions.includes(action))&&!denied.has(key as LegacyCapability))])) as CapabilitySet;
}
