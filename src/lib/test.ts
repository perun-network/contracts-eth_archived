/// <reference types="truffle-typings" />
import Web3 from "web3";
var web3 = new Web3(Web3.givenProvider || 'http://127.0.0.1:7545/');
import { promisify } from "util";


export async function sign(data: string, account: string) {
  let sig = await web3.eth.sign(web3.utils.soliditySha3(data), account);
  // fix wrong v value (add 27)
  let v = sig.slice(130, 132);
  return sig.slice(0,130) + (parseInt(v, 16)+27).toString(16);
}

export function ether(x: number): BN { return web3.utils.toWei(web3.utils.toBN(x), "ether"); }

export const hash = web3.utils.soliditySha3

export function sleep(milliseconds: any) {
   return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function asyncWeb3Send(method: string, params: any[], id?: number): Promise<any> {
  let req: any = { jsonrpc: '2.0', method: method, params: params };
  if (id != undefined) req.id = id;

  return promisify((callback) => {
    (web3.currentProvider as any).send(req, callback)
  })();
}

export function fundingID(channelID: string, participant: string) {
  return web3.utils.soliditySha3(channelID, participant);
}

export function snapshot(name: string, tests: any) {
  describe("Snapshot: " + name, () => {
    let snapshot_id: number;

    before("take snapshot before all tests", async () => {
      snapshot_id = (await asyncWeb3Send('evm_snapshot', [])).result;
    });

    after("restore snapshot after all test", async () => {
      return asyncWeb3Send('evm_revert', [snapshot_id]);
    });

    tests();
  });
}