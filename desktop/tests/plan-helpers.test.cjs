'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {providerError}=require('../integrations/antigravity.cjs');
test('Google errors classify quota and eligibility without disclosing credentials',()=>{
 for(const [message,expected] of [['RESOURCE_EXHAUSTED token=secret',/quota is exhausted/],['not eligible https://example.test/?code=private',/not enabled Antigravity/],['Bearer private-token',/could not finish/]]){const error=providerError({message});assert.match(error.message,expected);assert.doesNotMatch(error.message,/secret|private|example.test/);}
});
