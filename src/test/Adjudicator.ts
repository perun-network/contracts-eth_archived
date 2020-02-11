// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

import { assert, expect, should } from "chai";
import { sign, ether, hash, sleep, fundingID, snapshot } from "../lib/test";
should();
const truffleAssert = require('truffle-assertions');
import {
  AdjudicatorContract, AdjudicatorInstance,
  TrivialAppContract, TrivialAppInstance,
  AssetHolderETHContract, AssetHolderETHInstance
} from "../../types/truffle-contracts";
import Web3 from "web3";
import { stat } from "fs";
import { runInThisContext } from "vm";
import { toHex } from "web3-utils";

var web3 = new Web3(Web3.givenProvider || 'http://127.0.0.1:7545/');
const Adjudicator = artifacts.require<AdjudicatorContract>("Adjudicator");
const TrivialApp = artifacts.require<TrivialAppContract>("TrivialApp");
const AssetHolderETH = artifacts.require<AssetHolderETHContract>("AssetHolderETH");
const toBN = web3.utils.toBN;

class Params {
  app: string;
  challengeDuration: string;
  nonce: string;
  parts: string[];

  constructor(_app: string, _challengeDuration: string, _nonce: string, _parts: string[]) {
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
      [web3.utils.padLeft(this.challengeDuration, 64, "0"),
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

  constructor(parts: string[], balances: BN[], timeout: string, nonce: string, asset: string, app: string) {
    this.params = new Params(app, timeout, nonce, [parts[0], parts[1]]);
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    this.state = new State(this.params.channelID(), "0", outcome, "0x00", false);
    this.sigs = []
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
  const timeout = "60";
  const nonce = "0xB0B0FACE"
  const A = 0, B = 1;

  it("account[0] should deploy the Adjudicator contract", async () => {
    adj = await Adjudicator.new();
    let appInstance = await TrivialApp.new();
    app = appInstance.address;
    ah = await AssetHolderETH.new(adj.address);
    asset = ah.address;
  });

  // Register
  snapshot("Register, Refute, Progress before timeout", () => {
    const testsRegister = [
      {
        falsify: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "register with invalid channelID fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "register with invalid signature fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "register with validState succeeds",
        revert: false,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "register with validState twice fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { tx.state.version = "3"; await tx.sign(parts) },
        desc: "register with higher state fails",
        revert: true,
      }
    ]

    testsRegister.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app)
        tx.state.version = "2"
        await test.falsify(tx)
        if (test.revert) {
          await truffleAssert.reverts(
            adj.register(
              tx.params.serialize(),
              tx.state.serialize(),
              tx.sigs,
              { from: accounts[0] }),
          );
        } else {
          truffleAssert.eventEmitted(
            await adj.register(
              tx.params.serialize(),
              tx.state.serialize(),
              tx.sigs,
              { from: accounts[0] }),
            'Stored',
            (ev: any) => {
              return ev.channelID == tx.params.channelID()
                && ev.version == tx.state.version;
            }
          );
        }
      })
    });

    // refute
    const testsRefute = [
      {
        falsify: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "refuting with invalid channelID fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { tx.state.version = "2"; await tx.sign(parts) },
        desc: "refuting with old state fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "refuting with invalid signature fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "refuting with validState succeeds",
        revert: false,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "refuting with validState twice fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { tx.state.version = "5"; await tx.sign(parts) },
        desc: "refuting with higher state succeeds",
        revert: false,
      }
    ]

    testsRefute.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app)
        tx.state.version = "3"
        await test.falsify(tx)
        if (test.revert) {
          await truffleAssert.reverts(
            adj.refute(
              tx.params.serialize(),
              tx.state.serialize(),
              tx.sigs,
              { from: accounts[0] }),
          );
        } else {
          truffleAssert.eventEmitted(
            await adj.refute(
              tx.params.serialize(),
              tx.state.serialize(),
              tx.sigs,
              { from: accounts[0] }),
            'Stored',
            (ev: any) => {
              return ev.channelID == tx.params.channelID()
                && ev.version == tx.state.version;
            }
          );
        }
      })
    });

    // progress
    it("progress before timeout fails", async () => {
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app)
      txOld.state.version = "5"
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app)
      tx.state.version = "6"
      await tx.sign([parts[0], parts[0]])
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

  snapshot("RegisterFinal", () => {
    // Register final state
    it("A deposits 1 eth into a channel", async () => {
      let params = new Transaction(parts, balance, timeout, nonce, asset, app).params
      let id = fundingID(params.channelID(), parts[A]);
      truffleAssert.eventEmitted(
        await ah.deposit(id, ether(1), { value: ether(1), from: parts[A] }),
        'Deposited',
        (ev: any) => { return ev.fundingID == id; }
      );
    });

    it("B deposits 1 eth into a channel", async () => {
      let params = new Transaction(parts, balance, timeout, nonce, asset, app).params
      let id = fundingID(params.channelID(), parts[B]);
      truffleAssert.eventEmitted(
        await ah.deposit(id, ether(1), { value: ether(1), from: parts[B] }),
        'Deposited',
        (ev: any) => { return ev.fundingID == id; }
      );
    });

    const testsRegisterFinal = [
      {
        falsify: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "registerFinal with invalid channelID fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { tx.state.isFinal = false; await tx.sign(parts) },
        desc: "registerFinal with non-final state fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "registerFinal with invalid signature fails",
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "registerFinal with valid state succeeds",
        revert: false,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "registerFinal with valid state twice fails",
        revert: true,
      },
    ]

    testsRegisterFinal.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app)
        tx.state.version = "3"
        tx.state.isFinal = true
        await test.falsify(tx)
        if (test.revert) {
          await truffleAssert.reverts(
            adj.concludeFinal(
              tx.params.serialize(),
              tx.state.serialize(),
              tx.sigs,
              { from: accounts[0] }),
          );
        } else {
          truffleAssert.eventEmitted(
            await adj.concludeFinal(
              tx.params.serialize(),
              tx.state.serialize(),
              tx.sigs,
              { from: accounts[0] }),
            'OutcomePushed',
            (ev: any) => {
              return ev.channelID == tx.params.channelID()
                && ev.version == tx.state.version;
            }
          );
        }
      })
    });
  });

  snapshot("Conclude from challenge", async () => {
    // Conclude from challenge
    it("register valid state with 1 sec timeout", async () => {
      let tx = new Transaction(parts, balance, "1", nonce, asset, app)
      tx.state.version = "4"
      await tx.sign(parts)
      truffleAssert.eventEmitted(
        await adj.register(
          tx.params.serialize(),
          tx.state.serialize(),
          tx.sigs,
          { from: parts[A] }),
        'Stored',
        (ev: any) => {
          return ev.channelID == tx.params.channelID()
            && ev.version == tx.state.version;
        }
      );
    });

    it("A deposits 1 eth into a channel", async () => {
      let params = new Transaction(parts, balance, "1", nonce, asset, app).params
      let id = fundingID(params.channelID(), parts[A]);
      truffleAssert.eventEmitted(
        await ah.deposit(id, ether(1), { value: ether(1), from: parts[A] }),
        'Deposited',
        (ev: any) => { return ev.fundingID == id; }
      );
    });

    it("B deposits 1 eth into a channel", async () => {
      let params = new Transaction(parts, balance, "1", nonce, asset, app).params
      let id = fundingID(params.channelID(), parts[B]);
      truffleAssert.eventEmitted(
        await ah.deposit(id, ether(1), { value: ether(1), from: parts[B] }),
        'Deposited',
        (ev: any) => { return ev.fundingID == id; }
      );
    });

    const testsProgress = [
      {
        falsify: async (tx: Transaction) => { await sleep(1000); tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "progress with invalid channelID fails",
        actorIdx: 0,
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign([accounts[8], accounts[8]]) },
        desc: "progress with invalid signature fails",
        actorIdx: 0,
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with invalid actorIdx fails",
        actorIdx: 1,
        revert: true,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with valid state succeeds",
        actorIdx: 0,
        revert: false,
      },
      {
        falsify: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with the same valid state twice fails",
        actorIdx: 0,
        revert: true,
      },
    ]

    // Progress
    testsProgress.forEach(test => {
      it(test.desc, async () => {
        let txOld = new Transaction(parts, balance, "1", nonce, asset, app)
        txOld.state.version = "4"
        let tx = new Transaction(parts, balance, "1", nonce, asset, app)
        tx.state.version = "5"
        await test.falsify(tx)
        if (test.revert) {
          await truffleAssert.reverts(
            adj.progress(
              tx.params.serialize(),
              txOld.state.serialize(),
              tx.state.serialize(),
              test.actorIdx,
              tx.sigs[0],
              { from: accounts[0] }),
          );
        } else {
          truffleAssert.eventEmitted(
            await adj.progress(
              tx.params.serialize(),
              txOld.state.serialize(),
              tx.state.serialize(),
              test.actorIdx,
              tx.sigs[0],
              { from: accounts[0] }),
            'Stored',
            (ev: any) => {
              return ev.channelID == tx.params.channelID()
                && ev.version == tx.state.version;
            }
          );
        }
      })
    });

    it("Progressing with next valid state succeeds", async () => {
      let txOld = new Transaction(parts, balance, "1", nonce, asset, app)
      txOld.state.version = "5"
      let tx = new Transaction(parts, balance, "1", nonce, asset, app)
      tx.state.version = "6"
      await tx.sign(parts)
      truffleAssert.eventEmitted(
        await adj.progress(
          tx.params.serialize(),
          txOld.state.serialize(),
          tx.state.serialize(),
          0,
          tx.sigs[0],
          { from: accounts[0] }),
        'Stored',
        (ev: any) => {
          return ev.channelID == tx.params.channelID()
            && ev.version == tx.state.version;
        }
      );
    })
    // Conclude
    it("conclude from progressed challenge after timeout", async () => {
      await sleep(2000);
      let tx = new Transaction(parts, balance, "1", nonce, asset, app)
      tx.state.version = "6"
      truffleAssert.eventEmitted(
        await adj.conclude(
          tx.params.serialize(),
          tx.state.serialize(),
          { from: parts[A] }),
        'OutcomePushed',
        (ev: any) => {
          return ev.channelID == tx.params.channelID()
            && ev.version == tx.state.version;
        }
      );
    });
  });
});
