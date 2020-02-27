// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

import { assert, expect, should } from "chai";
should();
const truffleAssert = require('truffle-assertions');
import Web3 from "web3";
declare const web3: Web3;
import {
  AdjudicatorContract, AdjudicatorInstance,
  TrivialAppContract, TrivialAppInstance,
  AssetHolderETHContract, AssetHolderETHInstance
} from "../../types/truffle-contracts";
import { sign, ether, wei2eth, hash } from "../lib/web3";
import { fundingID, snapshot, advanceBlockTime } from "../lib/test";

const Adjudicator = artifacts.require<AdjudicatorContract>("Adjudicator");
const TrivialApp = artifacts.require<TrivialAppContract>("TrivialApp");
const AssetHolderETH = artifacts.require<AssetHolderETHContract>("AssetHolderETH");

class Params {
  app: string;
  challengeDuration: number;
  nonce: string;
  parts: string[];

  constructor(_app: string, _challengeDuration: number, _nonce: string, _parts: string[]) {
    this.app = _app;
    this.challengeDuration = _challengeDuration;
    this.nonce = _nonce;
    this.parts = _parts;
  }

  serialize() {
    return {
      app: this.app,
      challengeDuration: this.challengeDuration,
      nonce: this.nonce,
      participants: this.parts
    };
  }

  encode() {
    return web3.eth.abi.encodeParameters(
      ['uint256', 'uint256', 'address', 'address[]'],
      [this.challengeDuration,
      web3.utils.padLeft(this.nonce, 64, "0"),
      this.app,
      this.parts]);
  }

  channelID() {
    return hash(this.encode());
  }
}

class State {
  channelID: string;
  version: string;
  outcome: Allocation;
  appData: string;
  isFinal: boolean;

  constructor(_channelID: string, _version: string, _outcome: Allocation, _appData: string, _isFinal: boolean) {
    this.channelID = _channelID;
    this.version = _version;
    this.outcome = _outcome;
    this.appData = _appData;
    this.isFinal = _isFinal;
  }

  serialize() {
    return {
      channelID: this.channelID,
      version: this.version,
      outcome: this.outcome.serialize(),
      appData: this.appData,
      isFinal: this.isFinal
    }
  }

  encode() {
    return web3.eth.abi.encodeParameters(
      ['bytes32', 'uint64', 'bytes', 'bytes', 'bool'],
      [this.channelID,
      web3.utils.padLeft(this.version, 64, "0"),
      this.outcome.encode(),
      this.appData,
      this.isFinal]);
  }
}

class Allocation {
  assets: string[];
  balances: string[][];
  locked: SubAlloc[];

  constructor(_assets: string[], _balances: string[][], _locked: SubAlloc[]) {
    this.assets = _assets;
    this.balances = _balances;
    this.locked = _locked;
  }

  serialize() {
    let _locked: any[] = [];
    this.locked.forEach((e: any) => _locked.push(e.serialize()));
    return { assets: this.assets, balances: this.balances, locked: _locked };
  }

  encode() {
    var _locked = "0x";
    return web3.eth.abi.encodeParameters(
      ['address[]', 'uint256[][]', 'bytes'],
      [this.assets, this.balances, _locked]);
  }
}

class SubAlloc {
  id: string;
  balances: string[];

  constructor(id: string, _balances: string[]) {
    this.id = id;
    this.balances = _balances;
  }

  serialize() {
    return { ID: this.id, balances: this.balances };
  }

  encode() {
    return web3.eth.abi.encodeParameters(
      ['bytes32', 'uint256[]'],
      [web3.utils.padRight(this.id, 64, "0"), this.balances]);
  }
}

class Transaction {
  params: Params;
  state: State;
  sigs: string[];

  constructor(parts: string[], balances: BN[], challengeDuration: number, nonce: string, asset: string, app: string) {
    this.params = new Params(app, challengeDuration, nonce, [parts[0], parts[1]]);
    let outcome = new Allocation([asset], [[balances[0].toString(), balances[1].toString()]], []);
    this.state = new State(this.params.channelID(), "0", outcome, "0x00", false);
    this.sigs = [];
  }

  async sign(parts: string[]) {
    let stateHash = hash(this.state.encode());
    this.sigs = [await sign(this.state.encode(), parts[0]), await sign(this.state.encode(), parts[1])];
  }
}

contract("Adjudicator", async (accounts) => {
  let adj: AdjudicatorInstance;
  let ah: AssetHolderETHInstance;
  let app = "";
  let asset = "";
  const parts = [accounts[1], accounts[2]];
  const balance = [ether(10), ether(20)];
  const name = ["A", "B"];
  const timeout = 60;
  const nonce = "0xB0B0FACE";
  let params: Params;
  let channelID = "";
  const A = 0, B = 1;

  // adjudicator calls to register, refute, concludeFinal
  function adjcall(method: any, tx: Transaction): Promise<Truffle.TransactionResponse> {
    return method(
      tx.params.serialize(),
      tx.state.serialize(),
      tx.sigs,
      { from: accounts[0] },
    );
  }

  function register(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adjcall(adj.register, tx);
  }

  function refute(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adjcall(adj.refute, tx);
  }

  function concludeFinal(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adjcall(adj.concludeFinal, tx);
  }

  function conclude(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adj.conclude(tx.params.serialize(), tx.state.serialize(), { from: accounts[0] });
  }

  function assertEventEmitted(
    name: string, res: Truffle.TransactionResponse, tx: Transaction) {
    truffleAssert.eventEmitted(res, name,
      (ev: any) => {
        return ev.channelID == tx.params.channelID()
          && (!ev.version || (ev.version == tx.state.version));
      }
    );
  }

  it("account[0] should deploy the Adjudicator contract", async () => {
    adj = await Adjudicator.new();
    let appInstance = await TrivialApp.new();
    app = appInstance.address;
    ah = await AssetHolderETH.new(adj.address);
    asset = ah.address;

    // app deployed, we can calculate the default parameters and channel id
    params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    channelID = params.channelID();
  });

  function deposit(idx: number) {
    const bal = balance[idx];
    it(name[idx] + " deposits " + wei2eth(bal) + " eth on the asset holder", async () => {
      const fid = fundingID(channelID, parts[idx]);
      truffleAssert.eventEmitted(
        await ah.deposit(fid, bal, { value: bal, from: parts[idx] }),
        'Deposited',
        (ev: any) => { return ev.fundingID == fid && bal.eq(ev.amount); },
      );
    });
  }

  deposit(A);
  deposit(B);

  snapshot("Register, Refute, Progress before timeout", () => {
    const testsRegister = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "register with invalid channelID fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "register with invalid signature fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "register with validState succeeds",
        revert: false,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "register with validState twice fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "3"; await tx.sign(parts) },
        desc: "register with higher version fails",
        revert: true,
      }
    ]

    testsRegister.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app)
        tx.state.version = "2"
        await test.prepare(tx)
        let res = register(tx);
        if (test.revert) {
          await truffleAssert.reverts(res);
        } else {
          assertEventEmitted('Stored', await res, tx);
        }
      })
    });

    const testsRefute = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "refuting with invalid channelID fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "2"; await tx.sign(parts) },
        desc: "refuting with old state fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "refuting with invalid signature fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "refuting with validState succeeds",
        revert: false,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "refuting with validState twice fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "5"; await tx.sign(parts) },
        desc: "refuting with higher state succeeds",
        revert: false,
      }
    ]

    testsRefute.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "3";
        await test.prepare(tx);
        let res = refute(tx);
        if (test.revert) {
          await truffleAssert.reverts(res);
        } else {
          assertEventEmitted('Stored', await res, tx);
        }
      })
    });

    // progress
    it("progress before timeout fails", async () => {
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "5";
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await tx.sign([parts[0], parts[0]]);
      await truffleAssert.reverts(
        adj.progress(
          tx.params.serialize(),
          txOld.state.serialize(),
          tx.state.serialize(),
          0,
          tx.sigs[0],
          { from: accounts[0] }),
      );
    });
  });

  snapshot("concludeFinal", () => {
    const testsConcludeFinal = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "concludeFinal with invalid channelID fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.isFinal = false; await tx.sign(parts) },
        desc: "concludeFinal with non-final state fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "concludeFinal with invalid signature fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "concludeFinal with valid state succeeds",
        revert: false,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "concludeFinal with valid state twice fails",
        revert: true,
      },
    ]

    testsConcludeFinal.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "3";
        tx.state.isFinal = true;
        await test.prepare(tx);
        let res = concludeFinal(tx);
        if (test.revert) {
          await truffleAssert.reverts(res);
        } else {
          assertEventEmitted('OutcomePushed', await res, tx);
        }
      });
    });
  });

  describe("progress 4...6", async () => {
    it("register valid state (ver 4)", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "4";
      await tx.sign(parts);
      assertEventEmitted('Stored', await register(tx), tx);
    });

    const testsProgress = [
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with valid state before timeout fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          await advanceBlockTime(timeout + 10);
          tx.state.channelID = hash("wrongChannelID");
          await tx.sign(parts)
        },
        desc: "advance past timeout; progress with invalid channelID fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([accounts[8], accounts[8]]) },
        desc: "progress with invalid signature fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with invalid actorIdx fails",
        actorIdx: 1,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress (4->5) with valid state succeeds",
        actorIdx: 0,
        revert: false,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with the same valid state twice fails",
        actorIdx: 0,
        revert: true,
      },
    ]

    testsProgress.forEach(test => {
      it(test.desc, async () => {
        let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
        txOld.state.version = "4";
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "5";
        await test.prepare(tx);
        let res = adj.progress(
              tx.params.serialize(),
              txOld.state.serialize(),
              tx.state.serialize(),
              test.actorIdx,
              tx.sigs[0],
              { from: accounts[0] },
        );
        if (test.revert) {
          await truffleAssert.reverts(res);
        } else {
          assertEventEmitted('Stored', await res, tx);
        }
      })
    });

    it("progress (5->6) with next valid state succeeds", async () => {
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "5";
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await tx.sign(parts);
      let res = adj.progress(
        tx.params.serialize(),
        txOld.state.serialize(),
        tx.state.serialize(),
        0,
        tx.sigs[0],
        { from: accounts[0] },
      );
      assertEventEmitted('Stored', await res , tx);
    })
  });

  snapshot("concludeFinal bypasses ongoing dispute", () => {
    it("concludeFinal with ver 4", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "4";
      tx.state.isFinal = true;
      await tx.sign(parts);
      let res = await concludeFinal(tx);
      assertEventEmitted('OutcomePushed', res, tx);
      assertEventEmitted('Concluded', res, tx);
      assertEventEmitted('FinalConcluded', res, tx);
    });
  });

  // final conclude
  describe("conclude", () => {
    it("conclude from progressed challenge before timeout fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await truffleAssert.reverts(conclude(tx));
    });

    it("conclude from progressed challenge after timeout succeeds", async () => {
      await advanceBlockTime(timeout + 10);
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      let res = await conclude(tx);
      assertEventEmitted('OutcomePushed', res, tx);
      assertEventEmitted('Concluded', res, tx);
    });
  })
});
