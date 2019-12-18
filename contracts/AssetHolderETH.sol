// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

pragma solidity ^0.5.11;
pragma experimental ABIEncoderV2;
import "./AssetHolder.sol";
import "./SafeMath.sol";
import "./Sig.sol";

/**
 * @title The Perun AssetHolder
 * @author The Perun Authors
 * @dev AssetHolderETH is a concrete implementation of AssetHolder that handles the base currency.
 */
contract AssetHolderETH is AssetHolder {

    using SafeMath for uint256;

    /**
     * @notice Constructs a new instance of this contract.
     * @param _adjudicator The address of the adjudicator singleton contract.
     */
    constructor(address _adjudicator) public {
        adjudicator = _adjudicator;
    }

    /**
     * @notice Used to deposit money into a channel.
     * @dev Using the fundingID like this hides both the channelID as well as the participant address until a channel is settled.
     * @param fundingID Unique identifier for a participant in a channel.
     * @param amount Amount of money that should be deposited.
     */
    function deposit(bytes32 fundingID, uint256 amount) external payable {
        require(msg.value == amount, "wrong amount of ETH for deposit");
        holdings[fundingID] = holdings[fundingID].add(amount);
        emit Deposited(fundingID, amount);
    }

    /**
     * @notice Sends money from authorization.participant to authorization.receiver.
     * @param authorization WithdrawalAuth struct that is used to send money from an ephemeral key to an on-chain key.
     * @param signature Signature on the withdrawal authorization
     */
    function withdraw(WithdrawalAuth memory authorization, bytes memory signature) public {
        require(settled[authorization.channelID], "channel not settled");
        require(Sig.verify(abi.encode(authorization), signature, authorization.participant), "signature verification failed");
        bytes32 id = calcFundingID(authorization.channelID, authorization.participant);
        require(holdings[id] >= authorization.amount, "insufficient ETH for withdrawal");
        // Decrease holdings, then transfer the money.
        holdings[id] = holdings[id].sub(authorization.amount);
        authorization.receiver.transfer(authorization.amount);
    }
}
