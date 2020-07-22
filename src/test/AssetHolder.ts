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

/// <reference types="truffle-typings" />
import { assert, expect, should } from "chai";
should();
const truffleAssert = require('truffle-assertions');
import Web3 from "web3";
declare const web3: Web3;
import { AssetHolderETHContract, AssetHolderETHInstance } from "../../types/truffle-contracts";
import { sign, ether, wei2eth, hash } from "../lib/web3";
import { fundingID, snapshot } from "../lib/test";

const AssetHolderETH = artifacts.require<AssetHolderETHContract>("AssetHolderETH");
const toBN = web3.utils.toBN;

class Authorization {
  channelID: string;
  participant: string;
  receiver: string;
  amount: string;

  constructor(_channelID: string, _participant: string, _receiver: string, _amount: string) {
    this.channelID = _channelID;
    this.participant = _participant;
    this.receiver = _receiver;
    this.amount = _amount;
  }

  serialize() {
    return {
      channelID: this.channelID,
      participant: this.participant,
      receiver: this.receiver,
      amount: this.amount
    };
  }

  encode() {
    return web3.eth.abi.encodeParameters(
      ['bytes32','address','address','uint256'],
      [
        web3.utils.rightPad(this.channelID, 64, "0"),
        this.participant,
        this.receiver,
        web3.utils.padLeft(this.amount.toString(), 64, "0")
      ]
    );
  }
}

contract("AssetHolderETH", async (accounts) => {
  let ah: AssetHolderETHInstance;
  const channelID = hash("1234");
  const adj = accounts[0]; // emulated adjudicator contract
  const txSender = accounts[5]; // sender of transactions
  const parts = [accounts[1], accounts[2]];
  const balance = [ether(10), ether(20)];
  const timeout = 60;
  const recv = [accounts[3], accounts[4]];
  const finalBalance = [ether(20), ether(10)];
  const name = [ "A", "B" ];
  const A = 0, B = 1;

  it("account[0] should deploy the AssetHolderETH contract", async () => {
      ah = await AssetHolderETH.new(adj);
      let adjAddr = await ah.adjudicator();
      adjAddr.should.equal(adj);
  });

  async function assertHoldings(fid: string, amount: BN) {
    let c = await ah.holdings(fid);
    assert(amount.eq(c), "Wrong holdings");
  }

  it("set outcome of asset holder not from adjudicator", async () => {
    return truffleAssert.reverts(
      ah.setOutcome(channelID, parts, finalBalance, [], [], {from: parts[A]}),
    );
  });

  function testDeposit(idx: number, amount = balance[idx], cid = channelID) {
    let fid = fundingID(cid, parts[idx]);
    it(name[idx] + " deposits " + wei2eth(amount) + " eth", async () => {
      console.log("deposit fid:" + fid + ", amount: " + amount);
      let oldBal = await ah.holdings(fid);
      truffleAssert.eventEmitted(
        await ah.deposit(fid, amount, {value: amount, from: recv[idx]}),
        'Deposited',
        (ev: any) => {
          return ev.fundingID == fid && ev.amount.eq(amount);
        }
      );
      return assertHoldings(fid, amount.add(oldBal));
    });
  }

  function testWithdraw(idx: number, amount = finalBalance[idx], cid = channelID) {
    let fid = fundingID(cid, parts[idx]);
    it(name[idx] + " withdraws " + wei2eth(amount) + " eth with valid allowance", async () => {
      console.log("withdraw fid:" + fid + ", amount: " + amount);
      let balanceBefore = toBN(await web3.eth.getBalance(recv[idx]));
      let authorization = new Authorization(cid, parts[idx], recv[idx], amount.toString());
      let signature = await sign(authorization.encode(), parts[idx]);
      truffleAssert.eventEmitted(
        await ah.withdraw(authorization, signature, {from: txSender}),
        'Withdrawn',
        (ev: any) => {
          return ev.fundingID == fid
            && amount.eq(ev.amount)
            && ev.receiver == recv[idx];
        }
      );
      let balanceAfter = toBN(await web3.eth.getBalance(recv[idx]));
      assert(amount.add(balanceBefore).eq(balanceAfter), "wrong receiver balance");
    });
  }

  describe("Funding...", () => {

    testDeposit(A, ether(9));

    testDeposit(B);

    it("A sends too little money with call", async () => {
      let id = fundingID(channelID, parts[A]);
      await truffleAssert.reverts(
        ah.deposit(id, ether(10), {value: ether(1), from: parts[A]})
      );
      assertHoldings(id, ether(9));
    });

    testDeposit(A, ether(1));
  })

  snapshot("Set outcome", () => {
    it("set outcome from wrong origin", async () => {
      assert(finalBalance.length == parts.length);
      assert(await ah.settled(channelID) == false);
      await truffleAssert.reverts(
        ah.setOutcome(channelID, parts, finalBalance, [], [], {from: txSender}),
      );
    });
  })

  describe("Setting outcome", () => {
    it("set outcome of the asset holder", async () => {
      assert(finalBalance.length == parts.length);
      assert(await ah.settled(channelID) == false);
      truffleAssert.eventEmitted(
        await ah.setOutcome(channelID, parts, finalBalance, [], [], {from: adj}),
        'OutcomeSet' ,
        (ev: any) => { return ev.channelID == channelID }
      );
      assert(await ah.settled(channelID) == true);
      for (var i = 0; i < parts.length; i++) {
        let id = fundingID(channelID, parts[i]);
        await assertHoldings(id, finalBalance[i]);
      }
    });

    it("set outcome of asset holder twice", async () => {
      await truffleAssert.reverts(
        ah.setOutcome(channelID, parts, finalBalance, [], [], {from: adj})
      );
    });
  })

  snapshot("Invalid withdrawals", () => {
    it("withdraw with invalid signature", async () => {
      let authorization = new Authorization(channelID, parts[A], parts[B], finalBalance[A].toString());
      let signature = await sign(authorization.encode(), parts[B]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: txSender})
      );
    });

    it("withdraw with valid signature, invalid balance", async () => {
      let authorization = new Authorization(channelID, parts[A], parts[B], ether(30).toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: txSender})
      );
    });
  })

  describe("Withdraw", () => {

    testWithdraw(A);

    testWithdraw(B);

    it("A fails to overdraw with valid allowance", async () => {
      let authorization = new Authorization(channelID, parts[A], recv[A], finalBalance[A].toString());
      let signature = await sign(authorization.encode(), parts[A]);
      return truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: txSender})
      );
    });
  })

  describe("Test underfunded channel", () => {
    // check withdrawal after a party refuses to deposit funds into asset holder
    let channelID = hash("5678");

    testDeposit(A, ether(1), channelID);

    it("set outcome of the asset holder with deposit refusal", async () => {
      assert(finalBalance.length == parts.length);
      assert(await ah.settled(channelID) == false);
      truffleAssert.eventEmitted(
        await ah.setOutcome(channelID, parts, finalBalance, [], [], {from: adj}),
        'OutcomeSet',
        (ev: any) => { return ev.channelID == channelID; }
      );
      assert(await ah.settled(channelID), "channel not settled");
      let id = fundingID(channelID, parts[A]);
      assertHoldings(id, ether(1));
    });

    it("A fails to withdraw 2 eth after B's deposit refusal", async () => {
      let authorization = new Authorization(channelID, parts[A], recv[A], ether(2).toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: txSender})
      );
    });

    testWithdraw(A, ether(1), channelID);
  })

});
