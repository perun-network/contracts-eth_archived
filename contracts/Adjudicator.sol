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
    event FinalStateRegistered(bytes32 indexed channelID);
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
        Channel.Params memory p,
        Channel.State memory s,
        bytes[] memory sigs)
    public
    {
        bytes32 channelID = calcChannelID(p);
        require(s.channelID == channelID, "tried registering invalid channelID");
        require(disputes[channelID] == bytes32(0), "a dispute was already registered");
        validateSignatures(p, s, sigs);
        storeChallenge(p, s, channelID, DisputePhase.DISPUTE);
        emit Registered(channelID, s.version);
    }

    // Refute is called to refute a dispute.
    // It can only be called with a higher state.
    // The caller has to provide n signatures on the new state.
    // If the call was sucessful a Refuted event is emitted.
    function refute(
        Channel.Params memory p,
        Channel.State memory old,
        uint256 timeout,
        Channel.State memory s,
        bytes[] memory sigs)
    public beforeTimeout(timeout)
    {
        require(s.version > old.version, "only a refutation with a newer state is valid");
        bytes32 channelID = calcChannelID(p);
        require(s.channelID == channelID, "tried refutation with invalid channelID");
        require(disputes[channelID] == hashDispute(p, old, timeout, DisputePhase.DISPUTE),
            "provided wrong old state or timeout");
        validateSignatures(p, s, sigs);
        storeChallenge(p, s, channelID, DisputePhase.DISPUTE);
        emit Refuted(channelID, s.version);
    }

    // Progress is used to advance the state of an app on-chain.
    // It corresponds to the force-move functionality of magmo.
    // The caller only has to provide a valid signature from the mover.
    // This method can only advance the state by one.
    // If the call was successful, a Responded event is emitted.
    function progress(
        Channel.Params memory p,
        Channel.State memory old,
        uint256 timeout,
        DisputePhase disputePhase,
        Channel.State memory s,
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
        Channel.Params memory p,
        Channel.State memory s,
        uint256 timeout,
        DisputePhase disputePhase)
    public afterTimeout(timeout)
    {
        bytes32 channelID = calcChannelID(p);
        require(disputes[channelID] == hashDispute(p, s, timeout, disputePhase), "provided wrong old state or timeout");
        pushOutcome(channelID, p, s);
        emit Concluded(channelID);
    }

    // RegisterFinalState can be used to register a final state.
    // The caller has to provide n signatures on a finalized state.
    // It can only be called, if no other dispute was registered.
    // If the call was successful, a FinalStateRegistered event is emitted.
    function registerFinalState(
        Channel.Params memory p,
        Channel.State memory s,
        bytes[] memory sigs)
    public
    {
        require(s.isFinal == true, "only accept final states");
        bytes32 channelID = calcChannelID(p);
        require(s.channelID == channelID, "tried registering invalid channelID");
        require(disputes[channelID] == bytes32(0), "a dispute was already registered");
        validateSignatures(p, s, sigs);
        pushOutcome(channelID, p, s);
        emit FinalStateRegistered(channelID);
    }

    function calcChannelID(Channel.Params memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p.challengeDuration, p.nonce, p.app, p.participants));
    }

    function storeChallenge(
        Channel.Params memory p,
        Channel.State memory s,
        bytes32 channelID,
        DisputePhase disputePhase)
    internal
    {
        uint256 timeout = now.add(p.challengeDuration);
        disputes[channelID] = hashDispute(p, s, timeout, disputePhase);
        emit Stored(channelID, timeout);
    }

    function hashDispute(
        Channel.Params memory p,
        Channel.State memory s,
        uint256 timeout,
        DisputePhase disputePhase)
    internal pure returns (bytes32)
    {
        return keccak256(abi.encode(p, s, timeout, uint256(disputePhase)));
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
            require(oldAlloc.balances[i].length == newAlloc.balances[i].length, "length of balances[i] do not match");
            require(oldAlloc.balances[i].length == numParts, "length of balances[i] does not match numParts");
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
        Channel.Params memory p,
        Channel.State memory s)
    internal
    {
        uint256[][] memory balances = new uint256[][](s.outcome.assets.length);
        bytes32[] memory subAllocs = new bytes32[](s.outcome.locked.length);
        // Iterate over all subAllocations
        for(uint256 k = 0; k < s.outcome.locked.length; k++) {
            subAllocs[k] = s.outcome.locked[k].ID;
            // Iterate over all Assets
            for(uint256 i = 0; i < s.outcome.assets.length; i++) {
                // init subarrays
                if (k == 0)
                    balances[i] = new uint256[](s.outcome.locked.length);
                balances[i][k] = balances[i][k].add(s.outcome.locked[k].balances[i]);
            }
        }

        for (uint256 i = 0; i < s.outcome.assets.length; i++) {
            AssetHolder a = AssetHolder(s.outcome.assets[i]);
            require(s.outcome.balances[i].length == p.participants.length, "balances length should match participants length");
            a.setOutcome(channelID, p.participants, s.outcome.balances[i], subAllocs, balances[i]);
        }
        emit PushOutcome(channelID);
    }

    function validateSignatures(
        Channel.Params memory p,
        Channel.State memory s,
        bytes[] memory sigs)
    internal pure
    {
        require(p.participants.length == sigs.length, "invalid length of signatures");
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = recoverSigner(s, sigs[i]);
            require(p.participants[i] == signer, "invalid signature");
        }
    }

    function recoverSigner(
        Channel.State memory s,
        bytes memory sig)
    internal pure returns (address)
    {
        bytes memory subAlloc = abi.encode(s.outcome.locked[0].ID, s.outcome.locked[0].balances);
        bytes memory outcome = abi.encode(s.outcome.assets, s.outcome.balances, subAlloc);
        bytes memory state = abi.encode(s.channelID, s.version, outcome, s.appData, s.isFinal);
        bytes32 prefixedHash = ECDSA.toEthSignedMessageHash(keccak256(state));
        address recoveredAddr = ECDSA.recover(prefixedHash, sig);
        require(recoveredAddr != address(0), "recovered invalid signature");
        return recoveredAddr;
    }

}
