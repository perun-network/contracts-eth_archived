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
    return { app: this.app, challengeDuration: this.challengeDuration, nonce: this.nonce, participants: this.parts };
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
      channelID: this.channelID, version: this.version,
      outcome: this.outcome.serialize(), appData: this.appData, isFinal: this.isFinal
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

contract("Adjudicator", async (accounts) => {
  let adj: AdjudicatorInstance;
  let ah: AssetHolderETHInstance;
  let app: string;
  let asset: string
  const parts = [accounts[1], accounts[2]];
  const balance = [ether(10), ether(20)];
  const timeout = "60";
  const nonce = "0xB0B0FACE"
  const newBalances = [ether(20), ether(10)];
  const A = 0, B = 1;
  const DISPUTE = 0, FORCEMOVE = 1;

  it("account[0] should deploy the Adjudicator contract", async () => {
    adj = await Adjudicator.new();
    let appInstance = await TrivialApp.new();
    app = appInstance.address;
    ah = await AssetHolderETH.new(adj.address);
    asset = ah.address;
  });

  // Register

  it("register invalid channelID", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    // calculate channelID wrong:
    let channelID = hash("asdf");
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "0", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.register(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  it("registering state with invalid signatures fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "0", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[A])];
    await truffleAssert.reverts(
      adj.register(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  let validState: State;
  let validStateTimeout: string;

  it("register valid state", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "4", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    truffleAssert.eventEmitted(
      await adj.register(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: accounts[0] }),
      'Stored',
      (ev: any) => {
        validStateTimeout = ev.timeout;
        validState = state;
        return ev.channelID == channelID;
      }
    );
  });

  it("registering state twice fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "4", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.register(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  // refute

  it("refuting with old state fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "3", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.refute(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  it("refuting with wrong timeout fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.refute(
        params.serialize(),
        validState.serialize(),
        validStateTimeout + "1",
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  it("refuting with wrong channelID fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = hash("asdf");
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.refute(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  it("refuting with invalid signatures fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[A])];
    await truffleAssert.reverts(
      adj.refute(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        state.serialize(),
        sigs,
        { from: accounts[0] }),
    );
  });

  it("refuting with correct state succeeds", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    truffleAssert.eventEmitted(
      await adj.refute(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        state.serialize(),
        sigs,
        { from: accounts[0] }),
      'Stored',
      (ev: any) => {
        validStateTimeout = ev.timeout;
        validState = state;
        return ev.channelID == channelID;
      }
    );
  });

  // progress

  it("progress with incorrect version fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sig = await sign(state.encode(), parts[A]);
    await truffleAssert.reverts(
      adj.progress(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        DISPUTE,
        state.serialize(),
        0,
        sig,
        { from: accounts[0] }),
    );
  });

  it("progress before timeout fails", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "6", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sig = await sign(state.encode(), parts[A]);
    await truffleAssert.reverts(
      adj.progress(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        DISPUTE,
        state.serialize(),
        0,
        sig,
        { from: accounts[0] }),
    );
  });

  // Register final state

  it("a deposits 1 eth into a channel", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let id = fundingID(channelID, parts[A]);
    truffleAssert.eventEmitted(
      await ah.deposit(id, ether(1), { value: ether(1), from: parts[A] }),
      'Deposited',
      (ev: any) => { return ev.fundingID == id; }
    );
  });

  it("b deposits 1 eth into a channel", async () => {
    let params = new Params(app, timeout, nonce, [parts[A], parts[B]]);
    let channelID = params.channelID();
    let id = fundingID(channelID, parts[B]);
    truffleAssert.eventEmitted(
      await ah.deposit(id, ether(1), { value: ether(1), from: parts[B] }),
      'Deposited',
      (ev: any) => { return ev.fundingID == id; }
    );
  });

  it("register valid final state should reject wrong signatures", async () => {
    let params = new Params(app, timeout, "0xB0B0", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "4", outcome, "0x00", true); let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), accounts[0]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.concludeFinal(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: parts[B] })
    );
  });

  it("register valid final state should only accept final states", async () => {
    let params = new Params(app, timeout, "0xB0B0", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "4", outcome, "0x00", false); let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    await truffleAssert.reverts(
      adj.concludeFinal(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: parts[A] })
    );
  });

  it("register valid final state", async () => {
    let params = new Params(app, timeout, "0xB0B0", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "4", outcome, "0x00", true);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    truffleAssert.eventEmitted(
      await adj.concludeFinal(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: parts[A] }),
      'PushOutcome',
      (ev: any) => {
        return ev.channelID == channelID;
      }
    );
  });

  // Conclude from challenge

  it("register valid state with 1 sec timeout", async () => {
    let params = new Params(app, "1", "0xDEADBEEF", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "4", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sigs = [await sign(state.encode(), parts[A]), await sign(state.encode(), parts[B])];
    truffleAssert.eventEmitted(
      await adj.register(
        params.serialize(),
        state.serialize(),
        sigs,
        { from: parts[A] }),
      'Stored',
      (ev: any) => {
        validStateTimeout = ev.timeout;
        validState = state;
        return ev.channelID == channelID;
      }
    );
  });

  it("a deposits 1 eth into a channel", async () => {
    let params = new Params(app, "1", "0xDEADBEEF", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let id = fundingID(channelID, parts[A]);
    truffleAssert.eventEmitted(
      await ah.deposit(id, ether(1), { value: ether(1), from: parts[A] }),
      'Deposited',
      (ev: any) => { return ev.fundingID == id; }
    );
  });

  it("b deposits 1 eth into a channel", async () => {
    let params = new Params(app, "1", "0xDEADBEEF", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let id = fundingID(channelID, parts[B]);
    truffleAssert.eventEmitted(
      await ah.deposit(id, ether(1), { value: ether(1), from: parts[B] }),
      'Deposited',
      (ev: any) => { return ev.fundingID == id; }
    );
  });

  it("progress with invalid signature fails", async () => {
    await sleep(1000);
    let params = new Params(app, "1", "0xDEADBEEF", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sig = await sign(state.encode(), parts[A]);
    await truffleAssert.reverts(
      adj.progress(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        DISPUTE,
        state.serialize(),
        1,
        sig,
        { from: parts[A] })
    );
  });

  it("progress with correct state succeeds", async () => {
    let params = new Params(app, "1", "0xDEADBEEF", [parts[A], parts[B]]);
    let channelID = params.channelID();
    let outcome = new Allocation([asset], [[ether(1).toString(), ether(1).toString()]], []);
    let state = new State(channelID, "5", outcome, "0x00", false);
    let stateHash = hash(state.encode());
    let sig = await sign(state.encode(), parts[A]);
    truffleAssert.eventEmitted(
      await adj.progress(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        DISPUTE,
        state.serialize(),
        0,
        sig,
        { from: parts[A] }),
      'Stored',
      (ev: any) => {
        validStateTimeout = ev.timeout;
        validState = state;
        return ev.channelID == channelID;
      }
    );
  });

  it("conclude from progressed challenge after timeout", async () => {
    await sleep(2000);
    let params = new Params(app, "1", "0xDEADBEEF", [parts[A], parts[B]]);
    let channelID = params.channelID();
    truffleAssert.eventEmitted(
      await adj.concludeChallenge(
        params.serialize(),
        validState.serialize(),
        validStateTimeout,
        FORCEMOVE,
        { from: parts[A] }),
      'PushOutcome',
      (ev: any) => {
        return ev.channelID == channelID;
      }
    );
  });

});
