// Copyright (c) 2019 The Perun Authors. All rights reserved.
// This file is part of go-perun. Use of this source code is governed by a
// MIT-style license that can be found in the LICENSE file.

pragma solidity ^0.5.13;
pragma experimental ABIEncoderV2;
import "./SafeMath.sol";
import "./ECDSA.sol";

// AssetHolder is an abstract contract that holds the funds for a Perun state channel.
contract AssetHolder {

	using SafeMath for uint256;

	// WithdrawalAuthorization authorizes a on-chain public key to withdraw
	// from an ephemeral key.
	struct WithdrawalAuth {
		bytes32 channelID;
		address participant; // The account used to sign the authorization which is debited.
		address payable receiver; // The receiver of the authorization.
		uint256 amount; // The amount that can be withdrawn.
	}

	event OutcomeSet(bytes32 indexed channelID);
	event Deposited(bytes32 indexed fundingID, uint256 amount);

	// Mapping H(channelID||participant) => money
	mapping(bytes32 => uint256) public holdings;
	// Mapping channelID => settled
	mapping(bytes32 => bool) public settled;

	address public adjudicator;

	modifier onlyAdjudicator {
		require(msg.sender == adjudicator,
			"This method can only be called by the adjudicator contract");
		_;
	}

	// SetOutcome is called by the Adjudicator to set the final outcome of a channel.
	function setOutcome(
		bytes32 channelID,
		address[] calldata parts,
		uint256[] calldata newBals,
		bytes32[] calldata subAllocs,
		uint256[] calldata subBalances)
	external onlyAdjudicator {
		require(parts.length == newBals.length, "participants length should equal balances");
		require(subAllocs.length == subBalances.length, "length of subAllocs and subBalances should be equal");
		require(subAllocs.length == 0, "subAllocs currently not implemented");
		require(settled[channelID] == false, "trying to set already settled channel");

		// The channelID itself might already be funded
		uint256 sumHeld = holdings[channelID];
		uint256 sumOutcome = 0;

		bytes32[] memory fundingIDs = new bytes32[](parts.length);
		for (uint256 i = 0; i < parts.length; i++) {
			bytes32 id = calcFundingID(channelID, parts[i]);
			// Save calculated ids to save gas.
			fundingIDs[i] = id;
			// Compute old balances.
			sumHeld = sumHeld.add(holdings[id]);
			// Compute new balances.
			sumOutcome = sumOutcome.add(newBals[i]);
		}

		for (uint256 i = 0; i < subAllocs.length; i++) {
			sumOutcome = sumOutcome.add(subBalances[i]);
		}

		// We allow overfunding channels, who overfunds looses their funds.
		if (sumHeld >= sumOutcome) {
			for (uint256 i = 0; i < parts.length; i++) {
				holdings[fundingIDs[i]] = newBals[i];
			}
			for (uint256 i = 0; i < subAllocs.length; i++) {
				// use add to prevent overwriting of other funds.
				holdings[subAllocs[i]] = holdings[subAllocs[i]].add(subBalances[i]);
			}
		}
		settled[channelID] = true;
		emit OutcomeSet(channelID);
	}

	// VerifySignature verifies whether a piece of data was signed correctly.
	function verifySignature(bytes memory data, bytes memory signature, address signer) internal pure returns (bool) {
		bytes32 prefixedHash = ECDSA.toEthSignedMessageHash(keccak256(data));
		address recoveredAddr = ECDSA.recover(prefixedHash, signature);
		require(recoveredAddr != address(0));
		return recoveredAddr == signer;
	}

	function calcFundingID(bytes32 channelID, address participant) internal pure returns (bytes32) {
    	return keccak256(abi.encodePacked(channelID, participant));
	}

	function deposit(bytes32 fundingID, uint256 amount) external payable;
	function withdraw(WithdrawalAuth memory authorization, bytes memory signature) public;
}
