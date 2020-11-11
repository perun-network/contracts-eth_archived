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

// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "../vendor/openzeppelin-contracts/contracts/math/SafeMath.sol";
import "./Channel.sol";
import "./App.sol";
import "./AssetHolder.sol";
import "./SafeMath64.sol";

/**
 * @title The Perun Adjudicator
 * @author The Perun Authors
 * @dev Adjudicator is the contract that decides on the current state of a statechannel.
 */
contract Adjudicator {
    using SafeMath for uint256;
    using SafeMath64 for uint64;

    /**
     * @dev Our state machine has three phases.
     * In the DISPUTE phase, all parties have the ability to publish their latest state.
     * In the FORCEEXEC phase, the smart contract is executed on-chain.
     * In the CONCLUDED phase, the channel is considered finalized.
     */
    enum DisputePhase { DISPUTE, FORCEEXEC, CONCLUDED }

    struct Dispute {
        uint64 timeout;
        uint64 challengeDuration;
        uint64 version;
        bool hasApp;
        uint8 disputePhase;
        bytes32 stateHash;
    }

    /**
     * @dev Mapping channelID => Dispute.
     */
    mapping(bytes32 => Dispute) public disputes;

    event Registered(bytes32 indexed channelID, uint64 version);
    event Refuted(bytes32 indexed channelID, uint64 version);
    event Progressed(bytes32 indexed channelID, uint64 version);
    event Stored(bytes32 indexed channelID, uint64 version, uint64 timeout);
    event FinalConcluded(bytes32 indexed channelID);
    event Concluded(bytes32 indexed channelID, uint64 version);

    /**
     * @notice Register registers a non-final state of a channel.
     * If the call was successful a Registered event is emitted.
     *
     * @dev It can only be called if no other dispute is currently in progress.
     * The caller has to provide n signatures on the state.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function register(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        bytes32 channelID = channelID(params);
        require(state.channelID == channelID, "invalid channelID");
        require(disputes[channelID].stateHash == bytes32(0), "channel already registered");
        Channel.validateSignatures(params, state, sigs);
        storeChallenge(params, state, DisputePhase.DISPUTE, true);
        emit Registered(channelID, state.version);
    }

    /**
     * @notice Refute is called to refute a dispute.
     * If the call was successful a Refuted event is emitted.
     *
     * @dev Refute can only be called with a higher version state.
     * The caller has to provide n signatures on the new state.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function refute(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        bytes32 channelID = channelID(params);
        require(state.channelID == channelID, "invalid channelID");
        require(state.version > disputes[channelID].version, "can only refute with newer state");
        require(disputes[channelID].disputePhase == uint8(DisputePhase.DISPUTE), "must be in DISPUTE phase");
        // solhint-disable-next-line not-rely-on-time
        require(block.timestamp < disputes[channelID].timeout, "timeout passed");
        Channel.validateSignatures(params, state, sigs);
        storeChallenge(params, state, DisputePhase.DISPUTE, false);
        emit Refuted(channelID, state.version);
    }

    /**
     * @notice Progress is used to advance the state of an app on-chain.
     * If the call was successful, a Progressed event is emitted.
     *
     * @dev The caller has to provide a valid signature from the actor.
     * It is checked whether the new state is a valid transition from the old state,
     * so this method can only advance the state by one step.
     *
     * @param params The parameters of the state channel.
     * @param stateOld The previously stored state of the state channel.
     * @param state The new state to which we want to progress.
     * @param actorIdx Index of the signer in the participants array.
     * @param sig Signature of the participant that wants to progress the contract on the new state.
     */
    function progress(
        Channel.Params memory params,
        Channel.State memory stateOld,
        Channel.State memory state,
        uint256 actorIdx,
        bytes memory sig)
    public
    {
        require(actorIdx < params.participants.length, "actorIdx out of range");
        bytes32 channelID = channelID(params);
        if(disputes[channelID].disputePhase == uint8(DisputePhase.DISPUTE)) {
            // solhint-disable-next-line not-rely-on-time
            require(block.timestamp >= disputes[channelID].timeout, "timeout not passed");
        } else {
            require(disputes[channelID].disputePhase == uint8(DisputePhase.FORCEEXEC), "must be in FORCEEXEC phase");
            // solhint-disable-next-line not-rely-on-time
            require(block.timestamp < disputes[channelID].timeout, "timeout passed");
        }
        require(state.channelID == channelID, "invalid channelID");
        require(disputes[channelID].stateHash == hashState(stateOld), "wrong old state");
        require(Sig.verify(Channel.encodeState(state), sig, params.participants[actorIdx]), "invalid signature");
        requireValidTransition(params, stateOld, state, actorIdx);
        storeChallenge(params, state, DisputePhase.FORCEEXEC, true);
        emit Progressed(channelID, state.version);
    }

    /**
     * @notice Function `conclude` concludes the channel identified by `params` including its subchannels and pushes the accumulated outcome to the assetholders.
     * @dev Assumes:
     * - subchannels of `subStates` have participants `params.participants`
     * Requires:
     * - channel not yet concluded
     * - channel parameters valid
     * - channel states valid and registered
     * - dispute timeouts reached
     * Emits:
     * - event Concluded
     *
     * @param params The parameters of the channel and its subchannels.
     * @param state The previously stored state of the channel.
     * @param subStates The previously stored states of the subchannels in depth-first order.
     */
    function conclude(
        Channel.Params memory params,
        Channel.State memory state,
        Channel.State[] memory subStates)
    public
    {
        require(disputes[state.channelID].disputePhase != uint8(DisputePhase.CONCLUDED), "channel already concluded");
        require(state.channelID == channelID(params), "state and params mismatch");

        ensureTreeConcluded(state, subStates);
        pushOutcome(state, subStates, params.participants);
    }

    /**
     * @notice Function `concludeFinal` immediately concludes the channel
     * identified by `params` if the provided state is valid and final.
     * The caller must provide signatures from all participants.
     * Since any fully-signed final state supersedes any ongoing dispute,
     * concludeFinal may skip any registered dispute.
     * The function emits events Concluded and FinalConcluded.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function concludeFinal(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        require(disputes[state.channelID].disputePhase != uint8(DisputePhase.CONCLUDED), "channel already concluded");
        require(state.isFinal == true, "state not final");
        require(state.outcome.locked.length == 0, "cannot have sub-channels");
        require(state.channelID == channelID(params), "invalid channelID");
        Channel.validateSignatures(params, state, sigs);

        storeChallenge(params, state, DisputePhase.CONCLUDED, false);
        emit Concluded(state.channelID, state.version);
        emit FinalConcluded(state.channelID);

        Channel.State[] memory subStates = new Channel.State[](0);
        pushOutcome(state, subStates, params.participants);
    }

    /**
     * @notice Calculates the channel's ID from the given parameters.
     * @param params The parameters of the channel.
     * @return The ID of the channel.
     */
    function channelID(Channel.Params memory params) public pure returns (bytes32) {
        return keccak256(Channel.encodeParams(params));
    }

    /**
     * @notice Calculates the hash of a state.
     * @param state The state to hash.
     * @return The hash of the state.
     */
    function hashState(Channel.State memory state) public pure returns (bytes32) {
        return keccak256(Channel.encodeState(state));
    }

    /**
     * @dev Stores the provided challenge in the dispute registry, applying
     * timeout logic first.
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param disputePhase The phase in which the state channel is currently.
     * @param incrementTimeout Indicates whether the current phase timeout
     * should be incremented.
     */
    function storeChallenge(
        Channel.Params memory params,
        Channel.State memory state,
        DisputePhase disputePhase,
        bool incrementTimeout)
    internal
    {
        uint256 timeout;
        if (state.isFinal) {
            // final state should be immediately concludable
            // solhint-disable-next-line not-rely-on-time
            timeout = block.timestamp;
        } else if (incrementTimeout) {
            // solhint-disable-next-line not-rely-on-time
            timeout = block.timestamp.add(params.challengeDuration);
        } else {
            timeout = disputes[state.channelID].timeout;
        }

        disputes[state.channelID] = Dispute({
            timeout: uint64(timeout),
            challengeDuration: uint64(params.challengeDuration), // check whether params.challengeDuration does not exceed max(uint64)?
            version: state.version,
            hasApp: params.app != address(0),
            disputePhase: uint8(disputePhase),
            stateHash: hashState(state)
        });
        
        emit Stored(state.channelID, state.version, uint64(timeout));
    }

    /**
     * @dev Checks if a transition between two states is valid.
     * This calls the validTransition() function of the app.
     *
     * @param params The parameters of the state channel.
     * @param from The previous state of the state channel.
     * @param to The new state of the state channel.
     * @param actorIdx Index of the signer in the participants array.
     */
    function requireValidTransition(
        Channel.Params memory params,
        Channel.State memory from,
        Channel.State memory to,
        uint256 actorIdx)
    internal pure
    {
        require(to.version == from.version + 1, "version must increment by one");
        require(from.isFinal == false, "cannot progress from final state");
        requireAssetPreservation(from.outcome, to.outcome, params.participants.length);
        App app = App(params.app);
        app.validTransition(params, from, to, actorIdx);
    }

    /**
     * @dev Checks if two allocations are compatible, e.g. if the sums of the
     * allocations are equal.
     * @param oldAlloc The old allocation.
     * @param newAlloc The new allocation.
     * @param numParts length of the participants in the parameters.
     */
    function requireAssetPreservation(
        Channel.Allocation memory oldAlloc,
        Channel.Allocation memory newAlloc,
        uint256 numParts)
    internal pure
    {
        require(oldAlloc.balances.length == newAlloc.balances.length, "balances length mismatch");
        require(oldAlloc.assets.length == newAlloc.assets.length, "assets length mismatch");
        require(oldAlloc.locked.length == 0, "funds locked in old state");
        require(newAlloc.locked.length == 0, "funds locked in new state");
        for (uint256 i = 0; i < newAlloc.assets.length; i++) {
            require(oldAlloc.assets[i] == newAlloc.assets[i], "assets[i] address mismatch");
            uint256 sumOld = 0;
            uint256 sumNew = 0;
            require(oldAlloc.balances[i].length == numParts, "old balances length mismatch");
            require(newAlloc.balances[i].length == numParts, "new balances length mismatch");
            for (uint256 k = 0; k < numParts; k++) {
                sumOld = sumOld.add(oldAlloc.balances[i][k]);
                sumNew = sumNew.add(newAlloc.balances[i][k]);
            }

            require(sumOld == sumNew, "sum of balances mismatch");
        }
    }

    /**
     * @notice Function `ensureTreeConcluded` checks that `state` and
     * `substates` form a valid channel state tree and marks the corresponding
     * channels as concluded. The substates must be in depth-first order.
     * The function emits a Concluded event for every not yet concluded channel.
     * @dev The function works recursively using `ensureTreeConcludedRecursive`
     * and `ensureConcluded` as helper functions.
     *
     * @param state The previously stored state of the channel.
     * @param subStates The previously stored states of the subchannels in
     * depth-first order.
     */
    function ensureTreeConcluded(
        Channel.State memory state,
        Channel.State[] memory subStates)
    internal
    {
        ensureConcluded(state);
        uint256 index = ensureTreeConcludedRecursive(state, subStates, 0);
        require(index == subStates.length, "wrong number of substates");
    }

    /**
     * @notice Function `ensureTreeConcludedRecursive` is a helper function for
     * ensureTreeConcluded. It recursively checks the validity of the subchannel
     * states given a parent channel state. It then sets the channels concluded.
     * @param parentState The sub channels to be checked recursively.
     * @param subStates The states of all subchannels in the tree in depth-first
     * order.
     * @param startIndex The index in subStates of the first item of
     * subChannels.
     * @return The index of the next state to be checked.
     */
    function ensureTreeConcludedRecursive(
        Channel.State memory parentState,
        Channel.State[] memory subStates,
        uint256 startIndex)
    internal
    returns (uint256)
    {
        uint256 channelIndex = startIndex;
        Channel.SubAlloc[] memory locked = parentState.outcome.locked;
        for (uint256 i = 0; i < locked.length; i++) {
            Channel.State memory state = subStates[channelIndex];
            require(locked[i].ID == state.channelID, "invalid channel ID");
            ensureConcluded(state);

            channelIndex++;
            if (state.outcome.locked.length > 0) {
                channelIndex = ensureTreeConcludedRecursive(state, subStates, channelIndex);
            }
        }
        return channelIndex;
    }

    /**
     * @notice Function `ensureConcluded` checks for the given state
     * that it has been registered and its timeout is reached.
     * It then sets the channel as concluded and emits event Concluded.
     * @dev The function is a helper function for `ensureTreeConcluded`.
     * @param state The state of the target channel.
     */
    function ensureConcluded(
        Channel.State memory state)
    internal
    {
        Dispute memory dispute = disputes[state.channelID];
        require(dispute.stateHash == hashState(state), "invalid channel state");
        
        if (dispute.disputePhase == uint8(DisputePhase.CONCLUDED)) { return; }
        // if still in phase DISPUTE and the channel has an app, increase the
        // timeout by one duration to account for phase FORCEEXEC
        if (dispute.disputePhase == uint8(DisputePhase.DISPUTE) && dispute.hasApp) {
            dispute.timeout = dispute.timeout.add(dispute.challengeDuration);
        }
        // solhint-disable-next-line not-rely-on-time
        require(block.timestamp >= dispute.timeout, "timeout not passed yet");
        dispute.disputePhase = uint8(DisputePhase.CONCLUDED);
        disputes[state.channelID] = dispute;
        emit Concluded(state.channelID, state.version);
    }

    /**
     * @notice Function `pushOutcome` pushes the accumulated outcome of the
     * channel identified by `state.channelID` and its subchannels referenced by
     * `subStates` to the assetholder contracts.
     * The following must be guaranteed when calling the function:
     * - state and subStates conform with participants
     * - the outcome has not been pushed yet
     * @param state The state of the channel.
     * @param subStates The states of the subchannels of the channel in
     * depth-first order.
     * @param participants The participants of the channel and the subchannels.
     */
    function pushOutcome(
        Channel.State memory state,
        Channel.State[] memory subStates,
        address[] memory participants)
    internal
    {
        address[] memory assets = state.outcome.assets;

        for (uint256 a = 0; a < assets.length; a++) {
            // accumulate outcome over channel and subchannels
            uint256[] memory outcome = new uint256[](participants.length);
            for (uint256 p = 0; p < outcome.length; p++) {
                outcome[p] = state.outcome.balances[a][p];
                for (uint256 s = 0; s < subStates.length; s++) {
                    Channel.State memory subState = subStates[s];
                    require(subState.outcome.assets[a] == assets[a], "assets do not match");

                    // assumes participants at same index are the same
                    uint256 acc = outcome[p];
                    uint256 val = subState.outcome.balances[a][p];
                    outcome[p] = acc.add(val);
                }
            }

            // push accumulated outcome
            AssetHolder(assets[a]).setOutcome(state.channelID, participants, outcome);
        }
    }
}
