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

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;
import "./AssetHolder.sol";
import "./Sig.sol";
import "../vendor/SafeMath.sol";

/**
 * @title The Perun AssetHolder
 * @author The Perun Authors
 * @dev AssetHolderETH is a concrete implementation of AssetHolder that handles
 * the base currency.
 */
contract AssetHolderETH is AssetHolder {

    using SafeMath for uint256;

    /**
     * @notice Sets the adjudicator contract by calling the constructor of the
     * base asset holder contract.
     * @param _adjudicator Address of the adjudicator contract.
     */
    constructor(address _adjudicator) public AssetHolder(_adjudicator) {} // solhint-disable-line no-empty-blocks

    /**
     * @notice Used to deposit money into a channel.
     * @dev Using the fundingID like this hides both the channelID as well as
     * the participant address until a channel is settled.
     * @param fundingID Unique identifier for a participant in a channel.
     * @param amount Amount of money that should be deposited.
     */
    function deposit(bytes32 fundingID, uint256 amount) external payable override {
        require(msg.value == amount, "wrong amount of ETH for deposit");
        holdings[fundingID] = holdings[fundingID].add(amount);
        emit Deposited(fundingID, amount);
    }

    /**
     * @notice Sends money from authorization.participant to authorization.receiver.
     * @param authorization WithdrawalAuth struct that is used to send money
     * from an ephemeral key to an on-chain key.
     * @param signature Signature on the withdrawal authorization
     */
    function withdraw(WithdrawalAuth calldata authorization, bytes calldata signature) external override {
        require(settled[authorization.channelID], "channel not settled");
        require(Sig.verify(abi.encode(authorization), signature, authorization.participant),
                "signature verification failed");
        bytes32 id = calcFundingID(authorization.channelID, authorization.participant);
        require(holdings[id] >= authorization.amount, "insufficient ETH for withdrawal");
        // Decrease holdings, then transfer the money.
        holdings[id] = holdings[id].sub(authorization.amount);
        authorization.receiver.transfer(authorization.amount);
        emit Withdrawn(id, authorization.amount, authorization.receiver);
    }
}
