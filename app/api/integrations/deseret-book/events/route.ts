import { receiveDeseretRequest } from "../_service";
export const POST = (request: Request) => receiveDeseretRequest(request, false);
