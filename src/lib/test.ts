// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

/// <reference types="truffle-typings" />
import Web3 from "web3";
declare const web3: Web3;
import { hash, asyncWeb3Send } from "./web3";

export function sleep(milliseconds: any) {
   return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function advanceBlockTime(time: number): Promise<any> {
  await asyncWeb3Send('evm_increaseTime', [time]);
  return asyncWeb3Send('evm_mine', []);
}

export function fundingID(channelID: string, participant: string) {
  return hash(web3.eth.abi.encodeParameters(
      ['bytes32','address'],
      [web3.utils.rightPad(channelID, 64, "0"),
      participant]));
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
