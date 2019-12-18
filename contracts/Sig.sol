// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

pragma solidity ^0.5.13;
import "./ECDSA.sol";

// Sig is a library to verify signatures.
library Sig {

    // Verify verifies whether a piece of data was signed correctly.
    function verify(bytes memory data, bytes memory signature, address signer) internal pure returns (bool) {
        bytes32 prefixedHash = ECDSA.toEthSignedMessageHash(keccak256(data));
        address recoveredAddr = ECDSA.recover(prefixedHash, signature);
        require(recoveredAddr != address(0));
        return recoveredAddr == signer;
    }
}
