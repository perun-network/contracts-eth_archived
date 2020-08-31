// Copyright 2020 - See NOTICE file for copyright holders.
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

import "../vendor/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "../vendor/openzeppelin-contracts/contracts/math/SafeMath.sol";
import "./AssetHolder.sol";
import "./Sig.sol";

contract AssetHolderERC20 is AssetHolder {
	using SafeMath for uint256;

	IERC20 token;

	constructor(address _adjudicator, address _token) public AssetHolder(_adjudicator) {
		token = IERC20(_token);
	}

	 /**
     * @notice Used to deposit tokens into a channel.
     * @dev The sender has to set the allowance for the assetHolder to
	 * at least `amount`. The assetHolder will then use token.transferFrom
	 * to deposit `amount` tokens from the sender into the channel
	 * participant identified by `fundingID`.
	 * Using the fundingID like this hides both the channelID as
	 * well as the participant address until a channel is settled.
     * @param fundingID Unique identifier for a participant in a channel.
     * @param amount Amount of tokens that should be deposited.
     */
	function deposit(bytes32 fundingID, uint256 amount) external payable override {
		require(msg.value == 0, "message value must be 0 for token deposit");
		holdings[fundingID] = holdings[fundingID].add(amount);
		require(token.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
		emit Deposited(fundingID, amount);
	}

 	/**
     * @notice Withdraws tokens for channel participant authorization.participant
	 * to authorization.receiver.
     * @param authorization Withdrawal Authorization to authorize token transer
     * from a channel participant to an on-chain receiver.
     * @param signature Signature on the withdrawal authorization.
     */
	function withdraw(WithdrawalAuth memory authorization, bytes memory signature) external override {
		require(settled[authorization.channelID], "channel not settled");
		require(Sig.verify(abi.encode(authorization), signature, authorization.participant), "signature verification failed");
		bytes32 id = calcFundingID(authorization.channelID, authorization.participant);
		require(holdings[id] >= authorization.amount, "insufficient ETH for withdrawal");
		// Decrease holdings, then transfer the money.
		holdings[id] = holdings[id].sub(authorization.amount);
		require(token.transfer(authorization.receiver, authorization.amount), "transfer failed");
		emit Withdrawn(id, authorization.amount, authorization.receiver);
	}
}
