// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

/// <reference types="truffle-typings" />
import { assert, expect, should } from "chai";
import { sign, ether, fundingID, snapshot } from "../lib/test";
should();
const truffleAssert = require('truffle-assertions');
import { AssetHolderETHContract, AssetHolderETHInstance } from "../../types/truffle-contracts";
import Web3 from "web3";

var web3 = new Web3(Web3.givenProvider || 'http://127.0.0.1:7545/');
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
      amount: this.amount};
  }

  encode() {
    return web3.eth.abi.encodeParameters(
      ['bytes32','address','address','uint256'],
      [web3.utils.rightPad(this.channelID, 64, "0"),
      this.participant,
      this.receiver,
      web3.utils.padLeft(this.amount, 64, "0")]);
  }
}

contract("AssetHolderETH", async (accounts) => {
  let ah: AssetHolderETHInstance;
  let channelID = fundingID("1234", "asdfasdf");
  const parts = [accounts[1], accounts[2]];
  const balance = [ether(10), ether(20)];
  const timeout = 60;
  const newBalances = [ether(20), ether(10)];
  const A = 0, B = 1

  it("account[0] should deploy the AssetHolderETH contract", async () => {
      ah = await AssetHolderETH.new(accounts[0]);
      let adj = await ah.adjudicator();
      assert(adj == accounts[0]);
  });

  async function assertHoldings(id: string, amount: BN) {
    let c = await ah.holdings(id);
    assert(amount.eq(c), "Wrong holdings");
  }

  it("set outcome of asset holder not from adjudicator", async () => {
    await truffleAssert.reverts(
      ah.setOutcome(channelID, parts, newBalances, [], [], {from: parts[A]}),
    );
  });

  describe("Funding...", () => {
    it("A deposits 9 eth into a channel", async () => {
      let id = fundingID(channelID, parts[A]);
      await truffleAssert.eventEmitted(
        await ah.deposit(id, ether(9), {value: ether(9), from: parts[A]}),
        'Deposited',
        (ev: any) => {return ev.fundingID == id; }
      );
      assertHoldings(id, ether(9));
    });

    it("B deposits 20 eth into a channel", async () => {
      let id = fundingID(channelID, parts[B]);
      let amount = balance[B];
      await truffleAssert.eventEmitted(
        await ah.deposit(id, amount, {value: amount, from: parts[B]}),
        'Deposited',
        (ev: any) => { return ev.fundingID == id; }
      );
      assertHoldings(id, amount);
    });

    it("A sends too little money with call", async () => {
      let id = fundingID(channelID, parts[A]);
      await truffleAssert.reverts(
        ah.deposit(id, ether(10), {value: ether(1), from: parts[A]})
      );
      assertHoldings(id, ether(9));
    });

    it("A tops up their channel with 1 eth", async () => {
      let id = fundingID(channelID, parts[A]);
      await truffleAssert.eventEmitted(
        await ah.deposit(id, ether(1), {value: ether(1), from: parts[A]}),
        'Deposited',
        (ev: any) => { return ev.fundingID == id; }
      );
      assertHoldings(id, balance[A]);
    });
  })

  snapshot("Set outcome", () => {
    it("set outcome from wrong origin", async () => {
      assert(newBalances.length == parts.length);
      assert(await ah.settled(channelID) == false);
      await truffleAssert.reverts(
        ah.setOutcome(channelID, parts, newBalances, [], [], {from: accounts[3]}),
      );
    });
  })

  describe("Setting outcome", () => {
    it("set outcome of the asset holder", async () => {
      assert(newBalances.length == parts.length);
      assert(await ah.settled(channelID) == false);
      await truffleAssert.eventEmitted(
        await ah.setOutcome(channelID, parts, newBalances, [], [], {from: accounts[0]}),
        'OutcomeSet' ,
        (ev: any) => { return ev.channelID == channelID }
      );
      assert(await ah.settled(channelID) == true);
      for (var i = 0; i < parts.length; i++) {
        let id = fundingID(channelID, parts[i]);
        await assertHoldings(id, newBalances[i]);
      }
    });

    it("set outcome of asset holder twice", async () => {
      await truffleAssert.reverts(
        ah.setOutcome(channelID, parts, newBalances, [], [], {from: accounts[0]})
      );
    });
  })

  snapshot("Invalid withdrawals", () => {
    it("withdraw with invalid signature", async () => {
      let authorization = new Authorization(channelID, parts[A], parts[B], newBalances[A].toString());
      let signature = await sign(authorization.encode(), parts[B]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: accounts[3]})
      );
    });

    it("withdraw with valid signature, invalid balance", async () => {
      let authorization = new Authorization(channelID, parts[A], parts[B], ether(30).toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: accounts[3]})
      );
    });
  })

  describe("Withdraw", () => {
    it("A withdraws with valid allowance 20 eth", async () => {
      let balanceBefore = await web3.eth.getBalance(parts[A]);
      let authorization = new Authorization(channelID, parts[A], parts[A], newBalances[A].toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.eventEmitted(
        await ah.withdraw(authorization, signature, {from: accounts[3]}),
        'Withdrawn',
        (ev: any) => { return ev.amount == newBalances[A].toString(); }
      );
      let balanceAfter = await web3.eth.getBalance(parts[A]);
      assert(toBN(balanceBefore).add(ether(20)).eq(toBN(balanceAfter)));
    });

    it("B withdraws with valid allowance 10 eth", async () => {
      let balanceBefore = await web3.eth.getBalance(parts[B]);
      let authorization = new Authorization(channelID, parts[B], parts[B], newBalances[B].toString());
      let signature = await sign(authorization.encode(), parts[B]);
      await truffleAssert.eventEmitted(
        await ah.withdraw(authorization, signature, {from: accounts[3]}),
        'Withdrawn',
        (ev: any) => { return ev.amount == newBalances[B].toString(); }
      );
      let balanceAfter = await web3.eth.getBalance(parts[B]);
      assert(toBN(balanceBefore).add(ether(10)).eq(toBN(balanceAfter)));
    });

    it("overdraw with valid allowance", async () => {
      let authorization = new Authorization(channelID, parts[A], parts[B], newBalances[A].toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: accounts[3]})
      );
    });
  })

  describe("Test underfunded channel", () => {
    // check withdrawal after a party refuses to deposit funds into asset holder
    let channelID = fundingID("12345", "asdfasdf");

    it("a deposits 1 eth into a channel", async () => {
      let id = fundingID(channelID, parts[A]);
      truffleAssert.eventEmitted(
        await ah.deposit(id, ether(1), {value: ether(1), from: accounts[3]}),
        'Deposited',
        (ev: any) => {return ev.fundingID == id; }
      );
      assertHoldings(id, ether(1));
    });

    it("set outcome of the asset holder with deposit refusal", async () => {
      assert(newBalances.length == parts.length);
      assert(await ah.settled(channelID) == false);
      await truffleAssert.eventEmitted(
        await ah.setOutcome(channelID, parts, newBalances, [], [], {from: accounts[0]}),
        'OutcomeSet',
        (ev: any) => { return ev.channelID == channelID; }
      );
      assert(await ah.settled(channelID) == true);
      let id = fundingID(channelID, parts[A]);
      assertHoldings(id, ether(1));
    });

    it("A fails to withdraw 2 eth after B's deposit refusal", async () => {
      let authorization = new Authorization(channelID, parts[A], parts[A], ether(2).toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.reverts(
        ah.withdraw(authorization, signature, {from: accounts[3]})
      );
    });

    it("A withdraws 1 eth after B's deposit refusal", async () => {
      let balanceBefore = await web3.eth.getBalance(parts[A]);
      let authorization = new Authorization(channelID, parts[A], parts[A], ether(1).toString());
      let signature = await sign(authorization.encode(), parts[A]);
      await truffleAssert.eventEmitted(
        await ah.withdraw(authorization, signature, {from: accounts[3]}),
        'Withdrawn',
        (ev: any) => { return ev.amount == ether(1).toString(); }
      );
      let balanceAfter = await web3.eth.getBalance(parts[A]);
      assert(toBN(balanceBefore).add(ether(1)).eq(toBN(balanceAfter)));
    });
  })

});
