// Copyright (c) 2020 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

/// <reference types="truffle-typings" />

import { promisify } from "util";

import Web3 from "web3";
declare const web3: Web3;

export async function sign(data: string, account: string) {
  let sig = await web3.eth.sign(web3.utils.soliditySha3(data) as string, account);
  // fix wrong v value (add 27)
  let v = sig.slice(130, 132);
  return sig.slice(0,130) + (parseInt(v, 16)+27).toString(16);
}

export function ether(x: number): BN { return web3.utils.toWei(web3.utils.toBN(x), "ether"); }

export function wei2eth(x: BN): BN { return web3.utils.toBN(web3.utils.fromWei(x, "ether")); }

export function hash(...val: any[]): string {
  return web3.utils.soliditySha3(...val) as string
}

export async function asyncWeb3Send(method: string, params: any[], id?: number): Promise<any> {
  let req: any = { jsonrpc: '2.0', method: method, params: params };
  if (id != undefined) req.id = id;

  return promisify((callback) => {
    (web3.currentProvider as any).send(req, callback)
  })();
}

export async function currentTimestamp(): Promise<number> {
  let blocknumber = await web3.eth.getBlockNumber();
  let block = await web3.eth.getBlock(blocknumber);
  return block.timestamp as number;
}
