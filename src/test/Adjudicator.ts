// Copyright 2019 - See NOTICE file for copyright holders.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { assert, should } from "chai";
should();
const truffleAssert = require('truffle-assertions');
import Web3 from "web3";
declare const web3: Web3;
import {
  AdjudicatorContract,
  AdjudicatorInstance,
  TrivialAppContract,
  AssetHolderETHContract,
  AssetHolderETHInstance,
} from "../../types/truffle-contracts";
import { sign, ether, wei2eth, hash, asyncWeb3Send } from "../lib/web3";
import { fundingID, snapshot, advanceBlockTime, itWithRevert } from "../lib/test";
import BN from "bn.js";
import { numberToHex, stringToHex } from "web3-utils";

const Adjudicator = artifacts.require<AdjudicatorContract>("Adjudicator");
const TrivialApp = artifacts.require<TrivialAppContract>("TrivialApp");
const AssetHolderETH = artifacts.require<AssetHolderETHContract>("AssetHolderETH");

const zeroAddress = "0x0000000000000000000000000000000000000000";

enum DisputePhase { DISPUTE, FORCEEXEC, CONCLUDED }

class Channel {
  params: Params
  state: State

  constructor(params: Params, state: State) {
    this.params = params
    this.state = state
  }
}

class Params {
  challengeDuration: number;
  nonce: string;
  app: string;
  participants: string[];

  constructor(_app: string, _challengeDuration: number, _nonce: string, _parts: string[]) {
    this.app = _app;
    this.challengeDuration = _challengeDuration;
    this.nonce = _nonce;
    this.participants = _parts;
  }

  serialize() {
    return {
      app: this.app,
      challengeDuration: this.challengeDuration,
      nonce: this.nonce,
      participants: this.participants
    };
  }

  encode() {
    const paramsType = {
      "components": [
        {
          "internalType": "uint256",
          "name": "challengeDuration",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "nonce",
          "type": "uint256"
        },
        {
          "internalType": "address",
          "name": "app",
          "type": "address"
        },
        {
          "internalType": "address[]",
          "name": "participants",
          "type": "address[]"
        }
      ],
      "internalType": "struct Channel.Params",
      "name": "params",
      "type": "tuple"
    }
    return web3.eth.abi.encodeParameter(paramsType, this)
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
    const stateType = {
      "components": [
        {
          "internalType": "bytes32",
          "name": "channelID",
          "type": "bytes32"
        },
        {
          "internalType": "uint64",
          "name": "version",
          "type": "uint64"
        },
        {
          "components": [
            {
              "internalType": "address[]",
              "name": "assets",
              "type": "address[]"
            },
            {
              "internalType": "uint256[][]",
              "name": "balances",
              "type": "uint256[][]"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "ID",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256[]",
                  "name": "balances",
                  "type": "uint256[]"
                }
              ],
              "internalType": "struct Channel.SubAlloc[]",
              "name": "locked",
              "type": "tuple[]"
            }
          ],
          "internalType": "struct Channel.Allocation",
          "name": "outcome",
          "type": "tuple"
        },
        {
          "internalType": "bytes",
          "name": "appData",
          "type": "bytes"
        },
        {
          "internalType": "bool",
          "name": "isFinal",
          "type": "bool"
        }
      ],
      "internalType": "struct Channel.State",
      "name": "state",
      "type": "tuple"
    };

    return web3.eth.abi.encodeParameter(stateType, this);
  }

  async sign(signers: string[]): Promise<string[]> {
    return Promise.all(signers.map(signer => sign(this.encode(), signer)))
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
    let _locked: any[] = this.locked.map(e => e.serialize());
    return { assets: this.assets, balances: this.balances, locked: _locked };
  }
}

class SubAlloc {
  ID: string;
  balances: string[];

  constructor(id: string, _balances: string[]) {
    this.ID = id;
    this.balances = _balances;
  }

  serialize() {
    return { ID: this.ID, balances: this.balances };
  }
}

class Transaction extends Channel {
  sigs: string[];

  constructor(parts: string[], balances: BN[], challengeDuration: number, nonce: string, asset: string, app: string) {
    const params = new Params(app, challengeDuration, nonce, [parts[0], parts[1]]);
    const outcome = new Allocation([asset], [[balances[0].toString(), balances[1].toString()]], []);
    const state = new State(params.channelID(), "0", outcome, "0x00", false);
    super(params, state);
    this.sigs = [];
  }

  async sign(parts: string[]) {
    let stateEncoded = this.state.encode();
    this.sigs = await Promise.all(parts.map(participant => sign(stateEncoded, participant)));
  }
}

contract("Adjudicator", async (accounts) => {
  let adj: AdjudicatorInstance;
  let ah: AssetHolderETHInstance;
  let app = "";
  let asset = "";
  let assetIndex = 0;
  const parts = [accounts[1], accounts[2]];
  const balance = [ether(10), ether(20)];
  const name = ["A", "B"];
  const timeout = 60;
  const nonce = "0xB0B0FACE";
  let params: Params;
  let channelID = "";
  const A = 0, B = 1;

  function initialDeposit(idx: number) {
    const bal = balance[idx];
    it(name[idx] + " deposits " + wei2eth(bal) + " eth on the asset holder", async () => {
      await depositWithAssertions(channelID, parts[idx], bal);
    });
  }

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

  function progress(tx: Transaction, oldState: any, actorIdx: number, sig: string): Promise<Truffle.TransactionResponse> {
    return adj.progress(
      tx.params.serialize(),
      oldState,
      tx.state.serialize(),
      actorIdx,
      sig,
      { from: accounts[0] },
    );
  }

  function concludeFinal(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adjcall(adj.concludeFinal, tx);
  }

  function conclude(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adj.conclude(tx.params.serialize(), tx.state.serialize(), [], { from: accounts[0] });
  }

  function concludeWithSubchannels(ledgerChannel: Channel, subchannels: Channel[]): Promise<Truffle.TransactionResponse> {
    return adj.conclude(
      ledgerChannel.params.serialize(),
      ledgerChannel.state.serialize(),
      subchannels.map(subchannel => subchannel.state.serialize()),
      {from: accounts[0]}
    );
  }

  function assertEventEmitted(
    name: string, res: Truffle.TransactionResponse, channel: Channel) {
    truffleAssert.eventEmitted(res, name,
      (ev: any) => {
        return ev.channelID == channel.params.channelID()
          && (!ev.version || (ev.version == channel.state.version));
      }
    );
  }

  async function assertDisputePhase(channelID: string, phase: DisputePhase) {
    const dispute = await adj.disputes.call(channelID)
    const phaseIndex = 2
    assert(dispute[phaseIndex].eqn(phase), "wrong channel phase")
  }

  async function assertRegister(res: Promise<Truffle.TransactionResponse>, channel: Channel) {
    assertEventEmitted('Registered', await res, channel);
    assertEventEmitted('Stored', await res, channel);
    await assertDisputePhase(channel.state.channelID, DisputePhase.DISPUTE);
  }

  async function assertRefute(res: Promise<Truffle.TransactionResponse>, channel: Channel) {
    assertEventEmitted('Refuted', await res, channel);
    assertEventEmitted('Stored', await res, channel);
    await assertDisputePhase(channel.state.channelID, DisputePhase.DISPUTE);
  }

  async function assertProgress(res: Promise<Truffle.TransactionResponse>, channel: Channel) {
    assertEventEmitted('Progressed', await res, channel);
    assertEventEmitted('Stored', await res, channel);
    await assertDisputePhase(channel.state.channelID, DisputePhase.FORCEEXEC);
  }

  async function assertConclude(res: Promise<Truffle.TransactionResponse>, channel: Channel, subchannels: Channel[]) {
    /* this method currently only checks for the concluded and stored event of
    the ledger channel as it is not generally known which subchannels are not
    yet concluded. thus it is unclear for which subset of `subchannels` the
    events should be emitted. */
    assertEventEmitted('Concluded', await res, channel);

    await assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED);
    await Promise.all(subchannels.map(async channel => assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED)));

    const expectedOutcome = accumulatedOutcome(channel, subchannels);
    await Promise.all(channel.params.participants.map(async (user, userIndex) => {
      let outcome = await ah.holdings.call(fundingID(channel.state.channelID, user));
      assert(outcome.eq(expectedOutcome[userIndex]), "outcome not equal");
    }))
  }

  async function assertConcludeFinal(res: Promise<Truffle.TransactionResponse>, channel: Channel) {
    assertEventEmitted('Concluded', await res, channel);
    assertEventEmitted('FinalConcluded', await res, channel);
    await assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED);
  }

  async function depositWithAssertions(channelID: string, user: string, amount: BN) {    
    const fid = fundingID(channelID, user);
    truffleAssert.eventEmitted(
      await ah.deposit(fid, amount, { value: amount, from: user }),
      'Deposited',
      (ev: any) => { return ev.fundingID == fid && amount.eq(ev.amount); },
    );
  }

  function accumulatedOutcome(ledgerChannel: Channel, subchannels: Channel[]): BN[] {
    return ledgerChannel.params.participants.map((_, userIndex) => {
      let amount = new BN(ledgerChannel.state.outcome.balances[assetIndex][userIndex]);
      return amount.add(subchannels.reduce((acc, channel) => acc.add(new BN(channel.state.outcome.balances[assetIndex][userIndex])), new BN('0')));
    });
  }

  it("account[0] deploys the Adjudicator contract", async () => {
    adj = await Adjudicator.new();
    let appInstance = await TrivialApp.new();
    app = appInstance.address;
    ah = await AssetHolderETH.new(adj.address);
    asset = ah.address;

    // app deployed, we can calculate the default parameters and channel id
    params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    channelID = params.channelID();
  });

  initialDeposit(A);
  initialDeposit(B);

  snapshot("register and refute", () => {
    const testsRegister = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "register with invalid channelID fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0]]) },
        desc: "register with wrong number of signatures fails",
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
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "2";
        await test.prepare(tx);
        let res = register(tx);
        if (test.revert) {
          await truffleAssert.reverts(res);
        } else {
          await assertRegister(res, tx);
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
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.version = "6";
          await tx.sign(parts);
          await advanceBlockTime(timeout + 10);
        },
        desc: "refute after timeout fails",
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          let actorIdx = 0;
          tx.state.version = "5";
          let txOldSerialized = tx.state.serialize();
          tx.state.version = "6";
          await tx.sign(parts);
          let res = progress(tx, txOldSerialized, actorIdx, tx.sigs[actorIdx]);
          await assertProgress(res, tx);
          tx.state.version = "7";
          await tx.sign(parts);
        },
        desc: "refute in FORCEEXEC fails",
        revert: true,
      },
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
          await assertRefute(res, tx);
        }
      })
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
        prepare: async (tx: Transaction) => {
          tx.state.outcome.locked = [new SubAlloc(zeroAddress, [])]
          await tx.sign(parts)
        },
        desc: "concludeFinal with subchannels fails",
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
          await assertConcludeFinal(res, tx);
        }
      });
    });
  });

  snapshot("conclude with subchannels", () => {
    /* Create channel tree
    *      root
    *     /    \
    *   sub0   sub3
    *   /  \
    * sub1 sub2
    * 
    * subchannel 1 final, others non-final
    * concludefinal 1
    * register others
    * conclude all
    * withdraw
    */

    let ledgerChannel: Channel
    let subchannels: Channel[]

    function createChannel(nonce: string, version: string, balances: BN[]): Channel {
      let assets = [asset]
      let params = new Params(app, timeout, nonce, parts)
      let outcome = new Allocation(assets, [[balances[0].toString(), balances[1].toString()]], [])
      let state = new State(params.channelID(), version, outcome, "0x00", false)
      return new Channel(params, state)
    }

    function createParentChannel(nonce: string, version: string, balances: BN[], subchannels: Channel[]): Channel {
      let channel = createChannel(nonce, version, balances);
      channel.state.outcome.locked = subchannels.map(subchannel => toSubAlloc(subchannel.state));
      return channel;
    }

    function createInvalidSubchannel(): Channel {
      return createChannel("0", "0", balance);
    }

    function toSubAlloc(state: State): SubAlloc {
      let assetTotals = state.outcome.balances.map(balancesForAsset => balancesForAsset.reduce((acc, val) => acc.add(new BN(val)), new BN('0')));
      return new SubAlloc(state.channelID, assetTotals.map(assetTotal => assetTotal.toString()))
    }

    let nonceCounter = 0;
    function newNonce(): string {
      return (++nonceCounter).toString();
    }

    async function registerWithAssertions(channel: Channel) {
      let res = adj.register(
        channel.params.serialize(),
        channel.state.serialize(),
        await channel.state.sign(channel.params.participants),
        {from: accounts[0]}
      );
      await assertRegister(res, channel);
    }

    before(async () => {
      subchannels = Array.from({length: 4}).map(_ => {
        let nonce = newNonce()
        let version = nonce + nonce
        let nonceAsNumber = Number(nonce)
        return createChannel(nonce, version, [ether(nonceAsNumber), ether(2 * nonceAsNumber)])
      })
      subchannels[1].state.isFinal = true
      subchannels[0].state.outcome.locked = [
        toSubAlloc(subchannels[1].state),
        toSubAlloc(subchannels[2].state),
      ]
      ledgerChannel = createParentChannel(
        newNonce(),
        "10",
        [ether(10), ether(20)],
        [subchannels[0], subchannels[3]],
      );

      const outcome = accumulatedOutcome(ledgerChannel, subchannels);
      await Promise.all(ledgerChannel.params.participants.map((user: string, userIndex: number) =>
        depositWithAssertions(ledgerChannel.state.channelID, user, outcome[userIndex])))
    })

    it("register channel and subchannels", async () => {
      await registerWithAssertions(ledgerChannel)
      await Promise.all(subchannels.map(async subchannel => {
        if (subchannel.state.isFinal) { return }
        return registerWithAssertions(subchannel)
      }))
    });

    it("subchannel conclude final", async () => {
      const subchannel = subchannels[1];
      let res = adj.concludeFinal(
        subchannel.params.serialize(),
        subchannel.state.serialize(),
        await subchannel.state.sign(subchannel.params.participants),
        {from: accounts[0]}
      );
      await assertConcludeFinal(res, subchannel);
    });

    itWithRevert("conclude with wrong number of subchannels fails", async () => {
      await advanceBlockTime(timeout + 10);
      let invalidSubchannels = subchannels.slice();
      invalidSubchannels.push(createInvalidSubchannel());
      let res = concludeWithSubchannels(ledgerChannel, invalidSubchannels);
      await truffleAssert.reverts(res);
    });

    itWithRevert("conclude with wrong subchannel ID fails", async () => {
      await advanceBlockTime(timeout + 10);
      let invalidSubchannels = subchannels.slice();
      invalidSubchannels[0] = createInvalidSubchannel();
      let res = concludeWithSubchannels(ledgerChannel, invalidSubchannels);
      await truffleAssert.reverts(res);
    });

    itWithRevert("conclude with wrong assets fails", async () => {
      let subchannel = createChannel(newNonce(), "1", balance);
      let ledgerChannel = createParentChannel(
        newNonce(), "1", balance, [subchannel],
      );

      subchannel.state.outcome.assets = [zeroAddress];
      await registerWithAssertions(ledgerChannel);
      await registerWithAssertions(subchannel);

      await advanceBlockTime(timeout + 10);

      let res = concludeWithSubchannels(ledgerChannel, [subchannel]);
      await truffleAssert.reverts(res);
    });

    it("conclude ledger channel and subchannels", async () => {
      await advanceBlockTime(timeout + 10);
      let res = concludeWithSubchannels(ledgerChannel, subchannels);
      await assertConclude(res, ledgerChannel, subchannels);
    });
  });

  describe("progress", async () => {
    before(async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "4";
      await tx.sign(parts);
      let res = register(tx);
      assertRegister(res, tx);
    });

    let defaultActorIdx = 0;

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
        desc: "progress with invalid actor index fails",
        actorIdx: parts.length,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "6"; await tx.sign(parts) },
        desc: "progress with invalid version fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.balances = [];
          await tx.sign(parts);
        },
        desc: "progress with wrong number of balances fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.assets = [];
          await tx.sign(parts);
        },
        desc: "progress with wrong number of assets fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          let oldBalance = new BN(tx.state.outcome.balances[assetIndex][A]);
          tx.state.outcome.balances[assetIndex][A] = oldBalance.add(new BN(1)).toString();
          await tx.sign(parts);
        },
        desc: "progress with mismatching balances fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.locked = [new SubAlloc(zeroAddress, [])];
          await tx.sign(parts);
        },
        desc: "progress with locked funds in new state fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.assets = [zeroAddress];
          await tx.sign(parts);
        },
        desc: "progress with mismatching assets fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.balances = [[new BN(1).toString()]];
          await tx.sign(parts);
        },
        desc: "progress with wrong number of asset balances in new state fails",
        actorIdx: 0,
        revert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with valid state succeeds",
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
        let res = progress(tx, txOld.state.serialize(), test.actorIdx, tx.sigs[defaultActorIdx]);
        if (test.revert) {
          await truffleAssert.reverts(res);
        } else {
          await assertProgress(res, tx);
        }
      })
    });

    it("progress with next valid state succeeds", async () => {
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "5";
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await tx.sign(parts);
      let res = progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
      await assertProgress(res, tx);
    });

    itWithRevert("progress in CONCLUDED fails", async () => {
      await advanceBlockTime(timeout + 1);

      //conclude first
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "6";
      let resConclude = conclude(txOld);
      await assertConclude(resConclude, txOld, []);

      //then test progress
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "7";
      await tx.sign(parts);
      let res = progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
      await truffleAssert.reverts(res);
    });

    function testWithModifiedOldState(description: string, prepare: any) {
      itWithRevert(description, async () => {
        // prepare state and register
        let nonce = "1";
        let tx1 = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx1.state.version = "1";
        prepare(tx1);
        await tx1.sign(parts);
        let res0 = register(tx1);
        await assertRegister(res0, tx1);
  
        // test progress into new state
        let tx2 = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx2.state.version = "2";
        await tx2.sign(parts);
        await advanceBlockTime(timeout + 1);
        let actorIdx = 0;
        let res1 = progress(tx2, tx1.state.serialize(), actorIdx, tx2.sigs[actorIdx]);
        await truffleAssert.reverts(res1);
      });
    }

    testWithModifiedOldState(
      "progress with locked funds in old state fails",
      (tx: Transaction) => tx.state.outcome.locked = [new SubAlloc(zeroAddress, [])]
    );

    testWithModifiedOldState(
      "progress with wrong number of asset balances in old state fails",
      (tx: Transaction) => tx.state.outcome.balances = [[new BN(1).toString()]]
    );

    testWithModifiedOldState(
      "progress from final state fails",
      (tx: Transaction) => tx.state.isFinal = true
    );
  });

  snapshot("concludeFinal bypasses ongoing dispute", () => {
    it("concludeFinal with ver 4", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "4";
      tx.state.isFinal = true;
      await tx.sign(parts);
      let res = concludeFinal(tx);
      await assertConcludeFinal(res, tx);
    });
  });

  // final conclude
  describe("conclude", () => {
    it("conclude from progressed challenge before timeout fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await truffleAssert.reverts(conclude(tx));
    });

    it("conclude with invalid state fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "7";
      await truffleAssert.reverts(conclude(tx));
    });

    it("conclude with invalid params fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      tx.params.participants[1] = tx.params.participants[0];
      await truffleAssert.reverts(conclude(tx));
    });

    it("conclude from progressed challenge after timeout succeeds", async () => {
      await advanceBlockTime(timeout + 10);
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      let res = conclude(tx);
      await assertConclude(res, tx, []);
    });

    it("conclude twice fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await truffleAssert.reverts(conclude(tx));
    });
  })
});
