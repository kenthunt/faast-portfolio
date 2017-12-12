import { insertSwapData, updateSwapTx, setSwap, setWallet, resetAll } from 'Actions/redux'
import { getMarketInfo, postExchange, getOrderStatus } from 'Actions/request'
import { mockTransaction, mockPollTransactionReceipt, mockPollOrderStatus } from 'Actions/mock'
import { processArray } from 'Utilities/helpers'
import { getSwapStatus, statusAllSwaps } from 'Utilities/swap'
import { restoreFromAddress, sessionStorageSet, sessionStorageClear } from 'Utilities/storage'
import log from 'Utilities/log'
import blockstack from 'Utilities/blockstack'
import {
  toSmallestDenomination,
  toBigNumber,
  toHex,
  toTxFee,
  toPrecision,
  toChecksumAddress,
  toUnit
} from 'Utilities/convert'
import {
  tokenTxData,
  signTxWithPrivateKey,
  signTxWithHardwareWallet,
  sendSignedTransaction,
  sendTransaction,
  getTransactionReceipt,
  setWeb3,
  txWeb3
} from 'Utilities/wallet'

const swapFinish = (type, swap, error, addition) => {
  return (dispatch) => {
    const errors = swap.errors || []
    if (error) {
      errors.push({ [type]: new Error(error) })
      dispatch(insertSwapData(swap.from, swap.to, { errors }))
    }
    return Object.assign({}, swap, addition, { errors })
  }
}

const swapMarketInfo = (swapList) => (dispatch) => {
  return processArray(swapList, (a) => {
    const finish = (e, x) => dispatch(swapFinish('swapMarketInfo', a, e, x))
    if (a.from === a.to) return finish('cannot swap to same asset')

    return dispatch(getMarketInfo(a.pair))
      .then((res) => {
        log.debug('marketinfo response', res)
        if (!res.pair) {
          return finish('error getting details')
        }
        if (res.hasOwnProperty('minimum') && a.amount.lessThan(res.minimum)) {
          return finish(`minimum amount is ${res.minimum}`)
        }
        if (res.hasOwnProperty('min') && a.amount.lessThan(res.min)) {
          return finish(`minimum amount is ${res.min}`)
        }
        if ((res.hasOwnProperty('limit') && a.amount.greaterThan(res.limit)) || (res.maxLimit && a.amount.greaterThan(res.maxLimit))) {
          return finish(`maximum amount is ${res.limit}`)
        }
        const fee = res.hasOwnProperty('outgoing_network_fee') ? res.outgoing_network_fee : res.minerFee
        dispatch(insertSwapData(a.from, a.to, {
          rate: res.rate,
          fee
        }))
        return finish(null, { rate: res.rate, fee })
      })
      .catch((e) => {
        log.error(e)
        return finish('error getting details')
      })
  })
}

const swapPostExchange = (swapList, portfolio, address) => (dispatch) => {
  return processArray(swapList, (a) => {
    const finish = (e, x) => dispatch(swapFinish('swapPostExchange', a, e, x))

    return dispatch(postExchange({ withdrawal: address, pair: a.pair, returnAddress: address }))
      .then((res) => {
        const sendAsset = portfolio.list.find((b) => b.symbol === res.depositType.toUpperCase())
        const value = sendAsset.symbol === 'ETH' ? toSmallestDenomination(a.amount, sendAsset.decimals) : toBigNumber(0)
        let data
        if (sendAsset.symbol === 'ETH') {
          data = ''
        } else {
          const tokenData = tokenTxData(res.deposit, a.amount, sendAsset.decimals)
          if (tokenData.error) {
            log.error(tokenData.error)
            return finish('problem generating tx')
          }
          data = tokenData.data
        }
        const tx = {
          from: address,
          to: sendAsset.symbol === 'ETH' ? res.deposit : sendAsset.contractAddress,
          value: toHex(value),
          data,
          chainId: 1
        }
        dispatch(insertSwapData(res.depositType.toUpperCase(), res.withdrawalType.toUpperCase(), {
          order: res,
          tx
        }))
        return finish(null, { order: res, tx })
      })
      .catch((e) => {
        log.error(e)
        return finish('problem generating tx')
      })
  })
}

const swapEstimateTxFee = (swapList, address) => (dispatch) => {
  return Promise.all([
    window.faast.web3.eth.getTransactionCount(address),
    window.faast.web3.eth.getGasPrice()
  ])
  .then(([nonce, gasPrice]) => {
    return processArray(swapList, (a) => {
      const finish = (e, x) => dispatch(swapFinish('swapEstimateTxFee', a, e, x))

      if (!a.tx) return finish('no tx')
      if (!a.order) return finish('no order')

      return window.faast.web3.eth.estimateGas({
        from: a.tx.from,
        to: a.tx.to,
        data: a.tx.data
      })
      .then((gasLimit) => {
        const txAdd = {
          nonce: toHex(nonce),
          gasPrice: toHex(gasPrice),
          gasLimit: toHex(gasLimit)
        }
        nonce = nonce + 1
        dispatch(updateSwapTx(a.order.depositType.toUpperCase(), a.order.withdrawalType.toUpperCase(), txAdd))
        return finish(null, { tx: Object.assign({}, a.tx, txAdd) })
      })
      .catch((e) => {
        log.error(e)
        return finish('problem estimating gas')
      })
    })
  })
  .catch((e) => {
    log.error(e)
    return swapList
  })
}

// Checks to see if the deposit is high enough for the rate and swap fee
// so the expected amount ends up larger than zero
const swapSufficientDeposit = (swapList, portfolio) => (dispatch) => {
  return processArray(swapList, (a) => {
    const finish = (e, x) => dispatch(swapFinish('swapSufficientDeposit', a, e, x))

    const to = portfolio.list.find(b => b.symbol === a.to)
    const expected = toPrecision(toUnit(a.amount, a.rate, to.decimals).minus(a.fee), to.decimals)
    if (expected.lessThanOrEqualTo(0)) {
      return finish('insufficient deposit for expected return')
    }
    return finish()
  })
}

// Checks to see if there will be enough Ether if the full gas amount is paid
const swapSufficientEther = (swapList, portfolio) => (dispatch) => {
  let etherBalance = portfolio.list.find(a => a.symbol === 'ETH').balance
  return processArray(swapList, (a) => {
    const finish = (e, x) => dispatch(swapFinish('swapSufficientEther', a, e, x))

    if (a.from === 'ETH') etherBalance = etherBalance.minus(a.amount)
    etherBalance = etherBalance.minus(toTxFee(a.tx.gasLimit, a.tx.gasPrice))
    if (etherBalance.isNegative()) {
      return finish('not enough ether for tx fee')
    }
    return finish()
  })
}

export const initiateSwaps = (swap, portfolio, address) => (dispatch) => {
  log.info('swap submit initiated')
  const swapList = swap.reduce((a, b) => {
    return a.concat(b.list.map((c) => {
      return {
        from: b.symbol,
        to: c.symbol,
        amount: c.unit,
        pair: b.symbol.toLowerCase() + '_' + c.symbol.toLowerCase()
      }
    }))
  }, [])
  return dispatch(swapMarketInfo(swapList))
    .then((a) => dispatch(swapPostExchange(a, portfolio, address)))
    .then((a) => dispatch(swapSufficientDeposit(a, portfolio)))
    .then((a) => dispatch(swapEstimateTxFee(a, address)))
    .then((a) => dispatch(swapSufficientEther(a, portfolio)))
}

export const signTransactions = (swap, wallet, pk, isMocking) => (dispatch) => {
  return processArray(swap, (send) => {
    return processArray(send.list, (receive) => {
      let signTxPromise;
      if (pk) {
        signTxPromise = signTxWithPrivateKey(receive.tx, pk, isMocking)
      } else if (wallet.type === 'hardware') {
        signTxPromise = signTxWithHardwareWallet(wallet.data.type, wallet.data.derivationPath, receive.tx, isMocking)
      }
      return signTxPromise.then((signedTx) => {
        dispatch(updateSwapTx(send.symbol, receive.symbol, { signed: signedTx }))

        return signedTx
      })
    })
  })
}

// used for metamask
export const sendTransactions = (swap, isMocking) => (dispatch) => {
  return processArray(swap, (send) => {
    return processArray(send.list, (receive) => {
      if (isMocking) {
        return dispatch(mockTransaction(send, receive))
      }

      return dispatch(txPromiEvent(sendTransaction(txWeb3(receive.tx)), send, receive, true))
    })
  })
}

export const sendSignedTransactions = (swap, mock) => (dispatch) => {
  swap.forEach((send) => {
    send.list.forEach((receive) => {
      if (mock) {
        dispatch(mockTransaction(send, receive))
      } else {
        if (receive.tx.signed) {
          dispatch(txPromiEvent(sendSignedTransaction(receive.tx.signed), send, receive))
        } else {
          dispatch(insertSwapData(send.symbol, receive.symbol, { error: new Error('transaction not signed') }))
        }
      }
    })
  })
}

const txPromiEvent = (p, send, receive, markSigned) => (dispatch) => {
  let tx
  p
  .once('transactionHash', (txHash) => {
    log.info(`tx hash obtained - ${txHash}`)
    tx = txHash
    dispatch(insertSwapData(send.symbol, receive.symbol, { txHash }))
    if (markSigned) dispatch(updateSwapTx(send.symbol, receive.symbol, { signed: true }))
  })
  .once('receipt', (receipt) => {
    log.info('tx receipt obtained')
    dispatch(updateSwapTx(send.symbol, receive.symbol, { receipt }))
  })
  .on('confirmation', (conf) => {
    log.info(`tx confirmation obtained - ${conf}`)
    dispatch(updateSwapTx(send.symbol, receive.symbol, { confirmations: conf }))
  })
  .on('error', (error) => {
    log.error(error)
    // Don't mark the following as a tx error, start polling for receipt instead
    if (error.message.includes('Transaction was not mined within')) {
      return dispatch(pollTransactionReceipt(send, receive, tx))
    }
    const declined = error.message.includes('User denied transaction signature')
    dispatch(insertSwapData(send.symbol, receive.symbol, { error, declined }))
  })
  .then(() => {
    // once receipt is obtained
    dispatch(pollOrderStatus(send, receive))
  })
  .catch(log.error)
}

export const pollOrderStatus = (send, receive) => (dispatch) => {
  let orderStatusInterval
  orderStatusInterval = window.setInterval(() => {
    dispatch(getOrderStatus(send.symbol, receive.symbol, receive.order.deposit, receive.order.created))
    .then((order) => {
      if (order && (order.status === 'complete' || order.status === 'failed')) {
        return window.clearInterval(orderStatusInterval)
      }
    })
    .catch(log.error)
  }, 10000)
}

export const pollTransactionReceipt = (send, receive, tx) => (dispatch) => {
  const txHash = tx || receive.txHash
  if (!txHash) {
    const error = new Error('tx hash is missing, unable to poll for receipt')
    log.error(error)
    return dispatch(insertSwapData(send.symbol, receive.symbol, { error }))
  }
  let receiptInterval
  receiptInterval = window.setInterval(() => {
    getTransactionReceipt(txHash)
    .then((receipt) => {
      if (receipt) {
        window.clearInterval(receiptInterval)
        log.info('tx receipt obtained')
        dispatch(updateSwapTx(send.symbol, receive.symbol, { receipt }))
        dispatch(pollOrderStatus(send, receive))
      }
    })
    .catch(log.error)
  }, 5000)
}

export const restorePolling = (swap, isMocking) => (dispatch) => {
  swap.forEach((send) => {
    if (send && send.list) {
      send.list.forEach((receive) => {
        const status = getSwapStatus(receive)
        if (status.details === 'waiting for transaction receipt') {
          if (isMocking) {
            dispatch(mockPollTransactionReceipt(send, receive))
          } else {
            dispatch(pollTransactionReceipt(send, receive))
          }
        } else if (status.details === 'waiting for confirmations' || status.details === 'processing swap') {
          if (isMocking) {
            dispatch(mockPollOrderStatus(send, receive))
          } else {
            dispatch(pollOrderStatus(send, receive))
          }
        }
      })
    }
  })
}

export const openWallet = (type, wallet, isMocking, noSessionStorage) => (dispatch) => {
  const address = toChecksumAddress(wallet.address)
  if (address) {
    const state = restoreFromAddress(address)

    const status = statusAllSwaps(state && state.swap)
    const swap = (!state || status === 'unavailable' || status === 'unsigned' || status === 'unsent') ? undefined : state.swap

    if (swap) {
      dispatch(setSwap(swap))
      dispatch(restorePolling(swap, isMocking))
    }
    if (!noSessionStorage) {
      sessionStorageSet('wallet', JSON.stringify({
        type,
        address,
        data: wallet
      }))
    }

    setWeb3(type)
    dispatch(setWallet(type, address, wallet))
  }
}

export const closeWallet = () => (dispatch) => {
  blockstack.signUserOut()
  sessionStorageClear()
  dispatch(resetAll())
  log.info('wallet closed')
}
