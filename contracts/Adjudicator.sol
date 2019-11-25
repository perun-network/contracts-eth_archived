// Copyright (c) 2019 The Perun Authors. All rights reserved.
// This file is part of go-perun. Use of this source code is governed by a
// MIT-style license that can be found in the LICENSE file.

pragma solidity ^0.5.11;
pragma experimental ABIEncoderV2;

import "./Channel.sol";
import "./App.sol";
import "./AssetHolder.sol";
import "./SafeMath.sol";
import "./ECDSA.sol";

contract Adjudicator {

    using SafeMath for uint256;

    enum DisputePhase { DISPUTE, FORCEEXEC }

    // Mapping channelID => H(parameters, state, timeout).
    mapping(bytes32 => bytes32) public disputes;

    // Events used by the contract.
    event Registered(bytes32 indexed channelID, uint256 version);
    event Refuted(bytes32 indexed channelID, uint256 version);
    event Responded(bytes32 indexed channelID, uint256 version);
    event Stored(bytes32 indexed channelID, uint256 timeout);
    event FinalConcluded(bytes32 indexed channelID);
    event Concluded(bytes32 indexed channelID);
    event PushOutcome(bytes32 indexed channelID);

    // Restricts functions to only be called before a certain timeout.
    modifier beforeTimeout(uint256 timeout)
    {
        require(now < timeout, "function called after timeout");
        _;
    }

    // Restricts functions to only be called after a certain timeout.
    modifier afterTimeout(uint256 timeout)
    {
        require(now >= timeout, "function called before timeout");
        _;
    }

    // Register registers a non-final state of a channel.
    // It can only be called if no other dispute is currently in progress.
    // The caller has to provide n signatures on the state.
    // If the call was sucessful a Registered event is emitted.
    function register(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried registering invalid channelID");
        require(disputes[channelID] == bytes32(0), "a dispute was already registered");
        validateSignatures(params, state, sigs);
        storeChallenge(params, state, channelID, DisputePhase.DISPUTE);
        emit Registered(channelID, state.version);
    }

    // Refute is called to refute a dispute.
    // It can only be called with a higher state.
    // The caller has to provide n signatures on the new state.
    // If the call was sucessful a Refuted event is emitted.
    function refute(
        Channel.Params memory params,
        Channel.State memory stateOld,
        uint256 timeout,
        Channel.State memory state,
        bytes[] memory sigs)
    public beforeTimeout(timeout)
    {
        require(state.version > stateOld.version, "only a refutation with a newer state is valid");
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried refutation with invalid channelID");
        require(disputes[channelID] == hashDispute(params, stateOld, timeout, DisputePhase.DISPUTE),
            "provided wrong old state or timeout");
        validateSignatures(params, state, sigs);
        storeChallenge(params, state, channelID, DisputePhase.DISPUTE);
        emit Refuted(channelID, state.version);
    }

    // Progress is used to advance the state of an app on-chain.
    // It corresponds to the force-move functionality of magmo.
    // The caller only has to provide a valid signature from the mover.
    // This method can only advance the state by one.
    // If the call was successful, a Responded event is emitted.
    function progress(
        Channel.Params memory params,
        Channel.State memory stateOld,
        uint256 timeout,
        DisputePhase disputePhase,
        Channel.State memory state,
        uint256 actorIdx,
        bytes memory sig)
    public
    {
        if(disputePhase == DisputePhase.DISPUTE) {
            require(now >= timeout, "function called before timeout");
        }
        require(actorIdx < params.participants.length, "actorIdx out of range");
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried to respond with invalid channelID");
        require(disputes[channelID] == hashDispute(params, stateOld, timeout, disputePhase), "provided wrong old state or timeout");
        address signer = recoverSigner(state, sig);
        require(params.participants[actorIdx] == signer, "actorIdx is not set to the id of the sender");
        requireValidTransition(params, stateOld, state, actorIdx);
        storeChallenge(params, state, channelID, DisputePhase.FORCEEXEC);
        emit Responded(channelID, state.version);
    }

    // ConcludeChallenge is used to finalize a channel on-chain.
    // It can only be called after the timeout is over.
    // If the call was successful, a Concluded event is emitted.
    function concludeChallenge(
        Channel.Params memory params,
        Channel.State memory state,
        uint256 timeout,
        DisputePhase disputePhase)
    public afterTimeout(timeout)
    {
        bytes32 channelID = calcChannelID(params);
        require(disputes[channelID] == hashDispute(params, state, timeout, disputePhase), "provided wrong old state or timeout");
        pushOutcome(channelID, params, state);
        emit Concluded(channelID);
    }

    // ConcludeFinal can be used to register a final state.
    // The caller has to provide n signatures on a finalized state.
    // It can only be called, if no other dispute was registered.
    // If the call was successful, a FinalConcluded event is emitted.
    function concludeFinal(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        require(state.isFinal == true, "only accept final states");
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried registering invalid channelID");
        require(disputes[channelID] == bytes32(0), "a dispute was already registered");
        validateSignatures(params, state, sigs);
        pushOutcome(channelID, params, state);
        emit FinalConcluded(channelID);
        emit Concluded(channelID);
    }

    function calcChannelID(Channel.Params memory params) internal pure returns (bytes32) {
        return keccak256(abi.encode(params.challengeDuration, params.nonce, params.app, params.participants));
    }

    function storeChallenge(
        Channel.Params memory params,
        Channel.State memory state,
        bytes32 channelID,
        DisputePhase disputePhase)
    internal
    {
        uint256 timeout = now.add(params.challengeDuration);
        disputes[channelID] = hashDispute(params, state, timeout, disputePhase);
        emit Stored(channelID, timeout);
    }

    function hashDispute(
        Channel.Params memory params,
        Channel.State memory state,
        uint256 timeout,
        DisputePhase disputePhase)
    internal pure returns (bytes32)
    {
        return keccak256(abi.encode(params, state, timeout, uint256(disputePhase)));
    }

    function requireValidTransition(
        Channel.Params memory params,
        Channel.State memory from,
        Channel.State memory to,
        uint256 actorIdx)
    internal pure
    {
        require(to.version == from.version + 1, "can only advance the version counter by one");
        require(from.isFinal == false, "cannot advance from final state");
        requireAssetPreservation(from.outcome, to.outcome, params.participants.length);
        App app = App(params.app);
        require(app.validTransition(params, from, to, actorIdx), "invalid new state");
    }

    function requireAssetPreservation(
        Channel.Allocation memory oldAlloc,
        Channel.Allocation memory newAlloc,
        uint256 numParts)
    internal pure
    {
        require(oldAlloc.balances.length == newAlloc.balances.length, "length of balances do not match");
        require(oldAlloc.assets.length == newAlloc.assets.length, "length of assets do not match");
        for (uint256 i = 0; i < newAlloc.assets.length; i++) {
            require(oldAlloc.assets[i] == newAlloc.assets[i], 'asset addresses mismatch');
            uint256 sumOld = 0;
            uint256 sumNew = 0;
            require(oldAlloc.balances[i].length == numParts, "length of balances[i] of oldAlloc does not match numParts");
            require(newAlloc.balances[i].length == numParts, "length of balances[i] do newAlloc does not match numParts");
            for (uint256 k = 0; k < numParts; k++) {
                sumOld = sumOld.add(oldAlloc.balances[i][k]);
                sumNew = sumNew.add(newAlloc.balances[i][k]);
            }
            // Add the sums of all subAllocs
            for (uint256 k = 0; k < oldAlloc.locked.length; k++) {
                sumOld = sumOld.add(oldAlloc.locked[k].balances[i]);
                sumNew = sumNew.add(newAlloc.locked[k].balances[i]);
            }
            require(sumOld == sumNew, 'Sum of balances for an asset must be equal');
        }
    }


    function pushOutcome(
        bytes32 channelID,
        Channel.Params memory params,
        Channel.State memory state)
    internal
    {
        uint256[][] memory balances = new uint256[][](state.outcome.assets.length);
        bytes32[] memory subAllocs = new bytes32[](state.outcome.locked.length);
        // Iterate over all subAllocations
        for(uint256 k = 0; k < state.outcome.locked.length; k++) {
            subAllocs[k] = state.outcome.locked[k].ID;
            // Iterate over all Assets
            for(uint256 i = 0; i < state.outcome.assets.length; i++) {
                // init subarrays
                if (k == 0)
                    balances[i] = new uint256[](state.outcome.locked.length);
                balances[i][k] = balances[i][k].add(state.outcome.locked[k].balances[i]);
            }
        }

        for (uint256 i = 0; i < state.outcome.assets.length; i++) {
            AssetHolder a = AssetHolder(state.outcome.assets[i]);
            require(state.outcome.balances[i].length == params.participants.length, "balances length should match participants length");
            a.setOutcome(channelID, params.participants, state.outcome.balances[i], subAllocs, balances[i]);
        }
        emit PushOutcome(channelID);
    }

    function validateSignatures(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    internal pure
    {
        require(params.participants.length == sigs.length, "invalid length of signatures");
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = recoverSigner(state, sigs[i]);
            require(params.participants[i] == signer, "invalid signature");
        }
    }

    function recoverSigner(
        Channel.State memory state,
        bytes memory sig)
    internal pure returns (address)
    {
        bytes memory subAlloc = abi.encode(state.outcome.locked[0].ID, state.outcome.locked[0].balances);
        bytes memory outcome = abi.encode(state.outcome.assets, state.outcome.balances, subAlloc);
        bytes memory state = abi.encode(state.channelID, state.version, outcome, state.appData, state.isFinal);
        bytes32 prefixedHash = ECDSA.toEthSignedMessageHash(keccak256(state));
        address recoveredAddr = ECDSA.recover(prefixedHash, sig);
        require(recoveredAddr != address(0), "recovered invalid signature");
        return recoveredAddr;
    }

}
