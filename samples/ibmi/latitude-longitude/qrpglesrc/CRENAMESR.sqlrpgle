       //  _____________________________________________________________________
       //  Create the NAMESP file with SQL.
       //  _____________________________________________________________________
       ctl-opt
       copyright('(C) Copyright Booth Martin, 2020, All rights reserved.')
       option(*nodebugio) dftactgrp(*no) actgrp(*new);

      /free
       *inlr = *on;
       // The immediately following /EXEC SQL is SQL's version of RPG's H Spec.
       // It is never executed; it is used only at compile time.
       exec sql
         Set Option
           DatFmt = *ISO,
           Commit = *None;

       exec sql
         Create Table BENCZ1/NAMESP (
           NASEQ# decimal(5) not null
             generated always as identity
             (start with 1),
           NANAME char(30) not null,
           NAADDRESS1 char(30) not null,
           NAADDRESS2 char(30) not null,
           NACITY char(30) not null,
           NASTATE char(2),
           NAZIP char(10),
           primary key(NASEQ#) ) RCDFMT NAMESPR;
      /end-free
